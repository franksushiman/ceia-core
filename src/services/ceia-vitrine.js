/**
 * ceia-vitrine.js
 * Sincroniza o cardápio local (SQLite) com o WP central (ceia.ia.br).
 */

require("dotenv").config();

const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const sqlite3 = require("sqlite3").verbose();
const { ceiaEmitter } = require("./ceia-emitter");
const { getDataDir } = require("../lib/paths");

const db = new sqlite3.Database(path.join(getDataDir(), "ceia.db"));

// ── SQLite: WAL mode + busy retry ─────────────────────────────────────────────
db.run("PRAGMA journal_mode=WAL", (err) => {
  if (err) console.error("[VITRINE-DB] Erro ao ativar WAL:", err.message);
});
db.run("PRAGMA busy_timeout=5000");
db.get("PRAGMA journal_mode", (err, row) => {
  if (err) console.error("[VITRINE-DB] Erro ao verificar journal_mode:", err.message);
  else console.log(`[VITRINE-DB] journal_mode ativo: ${row.journal_mode}`);
});

const UPLOADS_DIR      = path.join(getDataDir(), "uploads");
const UPLOAD_TIMEOUT_MS = 30_000;

const CEIA_API_URL =
  process.env.CEIA_API_URL || "https://ceia.ia.br/wp-json/ceia/v1";
const TIMEOUT_MS = 15_000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const DEBOUNCE_MS = 4_000;
const DEBOUNCE_PAUSE_MS = 800; // esgotado é urgente — sync em ≤1s

// ─── Estado do serviço ────────────────────────────────────────────────────────
let ultimoSync = null;
let syncEmAndamento = false;
let syncTimer = null;

function getToken() {
  return process.env.CEIA_NODE_TOKEN || "";
}

// ─── vitrineFetch ─────────────────────────────────────────────────────────────
async function vitrineFetch(path, opts = {}) {
  const token = getToken();
  const url = `${CEIA_API_URL}${path}`;

  const headers = {
    "X-Ceia-Node-Token": token,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...opts, headers, signal: controller.signal });

    if (res.status === 401) {
      console.error("[CEIA] token inválido — reconfigura em /vitrine");
      return null;
    }

    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`[CEIA] timeout (${TIMEOUT_MS / 1000}s) em ${path}`);
    } else {
      console.error(`[CEIA] erro de rede em ${path}:`, err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Leitura do banco local ───────────────────────────────────────────────────
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })
  );
}

function _fmtBRL(v) {
  return 'R$ ' + (+(v || 0)).toFixed(2).replace('.', ',');
}

// Garante número limpo com 2 casas decimais (evita float IEEE 754 extendido no JSON)
function _preco(v) {
  return Math.round((+(v) || 0) * 100) / 100;
}

// Normaliza telefone para DDI+DDD+número (só dígitos). Ex: "(47) 99610-1947" → "5547996101947"
function _normalizeTelefone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // Já tem DDI 55 (13 dígitos = 55+DDD+9número, ou 12 = 55+DDD+8número)
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  // Adiciona DDI Brasil
  return '55' + digits;
}

// Calcula se a loja está aberta agora com base nas chaves horario_* do config.
// cfg: objeto { horario_seg_ativo:'1', horario_seg_ab:'18:00', horario_seg_fe:'23:00', ... }
function _calcAberto(cfg) {
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const d    = dias[new Date().getDay()];
  if (cfg[`horario_${d}_ativo`] !== '1') return false;
  const ab  = cfg[`horario_${d}_ab`] || '00:00';
  const fe  = cfg[`horario_${d}_fe`] || '23:59';
  const now = new Date();
  const hm  = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return hm >= ab && hm <= fe;
}

// Gera texto de horário para hoje. Ex: "Aberto até 23h" / "Abre às 18h" / "Seg-Sex: 18h–23h"
function _horarioTexto(cfg) {
  const DIAS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const LABEL   = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const hoje    = new Date().getDay(); // 0=dom
  const d       = DIAS_PT[hoje];

  const _hh = (hm) => hm ? hm.replace(/:00$/, 'h').replace(/:(\d+)$/, 'h$1') : null;

  if (cfg[`horario_${d}_ativo`] === '1') {
    const ab = cfg[`horario_${d}_ab`] || '00:00';
    const fe = cfg[`horario_${d}_fe`] || '23:59';
    const hm  = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    if (hm < ab) return `Abre às ${_hh(ab)}`;
    if (hm > fe) return `Fechado (abre ${LABEL[(hoje + 1) % 7]})`;
    return `Aberto até ${_hh(fe)}`;
  }

  // Hoje fechado — tenta montar intervalo de dias ativos
  const ativos = DIAS_PT.map((k, i) => ({ i, k, label: LABEL[i] }))
    .filter(x => cfg[`horario_${x.k}_ativo`] === '1');
  if (!ativos.length) return null;
  // Se bloco contíguo usa "Seg–Sex: 18h–23h"
  if (ativos.length >= 2 &&
      ativos[ativos.length - 1].i - ativos[0].i === ativos.length - 1) {
    const ab = cfg[`horario_${ativos[0].k}_ab`] || '00:00';
    const fe = cfg[`horario_${ativos[0].k}_fe`] || '23:59';
    return `${ativos[0].label}–${ativos[ativos.length - 1].label}: ${_hh(ab)}–${_hh(fe)}`;
  }
  return ativos.map(x => x.label).join(', ');
}

// Retorna o slug da loja (do DB cache ou buscando no hub).
// Ao buscar, persiste vitrine_slug e vitrine_loja_nome no config para o agente usar.
async function _obterSlug() {
  const row = await dbGet("SELECT value FROM config WHERE key = 'vitrine_slug'").catch(() => null);
  if (row?.value) return row.value;

  const r = await vitrineFetch("/node/info").catch(() => null);
  if (!r) return null;
  try {
    const data = await r.json();
    const slug = data.loja?.slug || null;
    if (slug) {
      await dbRun("INSERT OR REPLACE INTO config (key,value) VALUES ('vitrine_slug',?)", [slug]).catch(e => console.error('[VITRINE] falha em INSERT config(vitrine_slug):', e.message));
      const nome = data.loja?.nome || null;
      if (nome) await dbRun("INSERT OR REPLACE INTO config (key,value) VALUES ('vitrine_loja_nome',?)", [nome]).catch(e => console.error('[VITRINE] falha em INSERT config(vitrine_loja_nome):', e.message));
    }
    return slug;
  } catch (_) { return null; }
}

async function lerCardapio() {
  const [categorias, produtos, adicionais, opcoesAdicionais, prodAdicionais, bairros, variacoes, zonas, promocoesPublicas] =
    await Promise.all([
      dbAll("SELECT id, nome, ordem FROM categorias ORDER BY ordem"),
      dbAll(
        "SELECT id, categoria_id, nome, descricao, preco, preco_promocional, foto_url, esgotado, adicionais_grupos, tem_variacoes FROM produtos WHERE ativo = 1"
      ),
      dbAll(
        "SELECT id, nome, tipo, obrigatorio, min_escolhas, max_escolhas FROM adicionais"
      ),
      dbAll("SELECT id, adicional_id, nome, preco FROM adicionais_opcoes"),
      dbAll("SELECT produto_id, adicional_id FROM produto_adicionais"),
      dbAll("SELECT nome, taxa, tempo_min, tempo_max FROM bairros WHERE ativo = 1"),
      dbAll("SELECT id, produto_id, nome, preco, ordem FROM variacoes ORDER BY produto_id, ordem"),
      dbAll("SELECT nome, taxa, tempo_min, tempo_max FROM zonas WHERE ativa = 1 ORDER BY ordem, id"),
      // Promoções públicas ativas — somente visibilidade='publica' E ativa=1
      dbAll("SELECT id, nome, descricao, beneficio_tipo, beneficio_valor, imagem, zonas_excluidas, dias_semana, hora_inicio, hora_fim FROM promocoes WHERE visibilidade = 'publica' AND ativa = 1 ORDER BY criado_em DESC"),
    ]);

  // Mapeia opções nos grupos de adicionais
  const opcoesPorAdicional = {};
  for (const op of opcoesAdicionais) {
    if (!opcoesPorAdicional[op.adicional_id]) opcoesPorAdicional[op.adicional_id] = [];
    opcoesPorAdicional[op.adicional_id].push({ nome: op.nome, preco: op.preco });
  }

  // Mapeia adicionais por produto (via join table)
  const adicionaisPorProduto = {};
  for (const pa of prodAdicionais) {
    if (!adicionaisPorProduto[pa.produto_id]) adicionaisPorProduto[pa.produto_id] = [];
    adicionaisPorProduto[pa.produto_id].push(pa.adicional_id);
  }

  // Mapeia variações por produto
  const variacoesPorProduto = {};
  for (const v of variacoes) {
    if (!variacoesPorProduto[v.produto_id]) variacoesPorProduto[v.produto_id] = [];
    variacoesPorProduto[v.produto_id].push({ id: v.id, nome: v.nome, preco: v.preco, ordem: v.ordem });
  }

  const config = await lerConfig();

  // Zonas ativas como bairros (formato simplificado para WP checkout)
  const zonasComoB = zonas.map(z => ({ nome: z.nome, taxa: z.taxa, tempo_min: z.tempo_min, tempo_max: z.tempo_max }));
  // Bairros legados sem sobreposição com zonas
  const zonasNomes = new Set(zonasComoB.map(z => z.nome));
  const bairrosMerged = [...zonasComoB, ...bairros.filter(b => !zonasNomes.has(b.nome))];

  // Promoções públicas: parseia campos JSON (zonas_excluidas, dias_semana)
  const _tryParse = (v) => { try { return v ? JSON.parse(v) : null; } catch (_) { return null; } };

  return {
    categorias: categorias.map((c) => ({ id: c.id, nome: c.nome, ordem: c.ordem })),
    produtos: produtos.map((p) => {
      let adicionaisGrupos = [];
      try { const raw = p.adicionais_grupos; if (raw) adicionaisGrupos = JSON.parse(raw); } catch (_) {}
      if (!adicionaisGrupos.length) adicionaisGrupos = adicionaisPorProduto[p.id] || [];
      return {
        id: p.id, categoria_id: p.categoria_id, nome: p.nome, descricao: p.descricao,
        preco: p.preco, preco_promocional: p.preco_promocional, foto_url: p.foto_url,
        esgotado: p.esgotado === 1,
        adicionais_grupos: adicionaisGrupos,
        variacoes: p.tem_variacoes ? (variacoesPorProduto[p.id] || []) : [],
      };
    }),
    adicionais: adicionais.map((a) => ({
      id: a.id, nome: a.nome, tipo: a.tipo, obrigatorio: a.obrigatorio === 1,
      min_escolhas: a.min_escolhas, max_escolhas: a.max_escolhas,
      opcoes: opcoesPorAdicional[a.id] || [],
    })),
    bairros: bairrosMerged,
    zonas: zonasComoB,
    config,
    // Promoções públicas ativas — segmentadas e inativas NUNCA entram aqui
    promocoes: promocoesPublicas.map((p) => ({
      id:              p.id,
      nome:            p.nome,
      descricao:       p.descricao || null,
      beneficio_tipo:  p.beneficio_tipo,
      beneficio_valor: p.beneficio_valor,
      imagem:          p.imagem || null,   // mesmo formato que foto_url de produto
      zonas_excluidas: _tryParse(p.zonas_excluidas),
      dias_semana:     _tryParse(p.dias_semana),
      hora_inicio:     p.hora_inicio || null,
      hora_fim:        p.hora_fim || null,
    })),
  };
}

async function lerConfig() {
  const horarios = await dbGet(
    "SELECT value FROM config WHERE key = 'horarios'"
  );
  const pedidoMinimo = await dbGet(
    "SELECT value FROM config WHERE key = 'pedido_minimo'"
  );
  const formasPagamento = await dbGet(
    "SELECT value FROM config WHERE key = 'formas_pagamento'"
  );

  return {
    horarios: horarios ? JSON.parse(horarios.value) : null,
    pedido_minimo: pedidoMinimo ? parseFloat(pedidoMinimo.value) : 0,
    formas_pagamento: formasPagamento
      ? JSON.parse(formasPagamento.value)
      : ["PIX", "Cartão", "Dinheiro"],
  };
}

// ─── Cache de imagens (hash → URL pública) ───────────────────────────────────
let _cacheTableReady = false;

async function _ensureCacheTable() {
  if (_cacheTableReady) return;
  await dbRun(`CREATE TABLE IF NOT EXISTS vitrine_image_cache (
    hash       TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    criado_em  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  _cacheTableReady = true;
}

async function _imgCacheGet(hash) {
  await _ensureCacheTable();
  const row = await dbGet("SELECT url FROM vitrine_image_cache WHERE hash = ?", [hash]).catch(() => null);
  return row?.url || null;
}

async function _imgCacheSet(hash, url) {
  await _ensureCacheTable();
  await dbRun("INSERT OR REPLACE INTO vitrine_image_cache (hash, url) VALUES (?, ?)", [hash, url]).catch(e => console.error('[VITRINE] falha em INSERT vitrine_image_cache:', e.message));
}

// Retorna true se a URL aponta para o servidor local (não acessível publicamente)
function _isUrlLocal(rawUrl) {
  if (!rawUrl) return false;
  return rawUrl.startsWith("/uploads/")        ||
         rawUrl.startsWith("http://127.0.0.1") ||
         rawUrl.startsWith("http://localhost")  ||
         rawUrl.startsWith("file://");
}

// Converte URL/path local → caminho absoluto no disco, ou null se não resolvível
function _resolverCaminhoLocal(rawUrl) {
  if (!rawUrl) return null;
  try {
    if (rawUrl.startsWith("/uploads/")) {
      return path.join(UPLOADS_DIR, rawUrl.slice("/uploads/".length));
    }
    if (rawUrl.startsWith("http://127.0.0.1") || rawUrl.startsWith("http://localhost")) {
      const u = new URL(rawUrl);
      if (u.pathname.startsWith("/uploads/"))
        return path.join(UPLOADS_DIR, u.pathname.slice("/uploads/".length));
    }
  } catch (_) {}
  return null;
}

// Resolve imagens locais → URLs públicas via upload para o WP.
// Retorna: { imgMap: Map<localUrl,publicUrl|null>, enviadas, cache, falhas }
async function _resolverImagensPublicas(urlsLocais, token) {
  let enviadas = 0, emCache = 0, falhas = 0;
  const imgMap = new Map();

  for (const rawUrl of urlsLocais) {
    const filePath = _resolverCaminhoLocal(rawUrl);
    if (!filePath || !fs.existsSync(filePath)) {
      imgMap.set(rawUrl, null);
      falhas++;
      continue;
    }

    try {
      const data    = fs.readFileSync(filePath);
      const hash    = crypto.createHash("sha1").update(data).digest("hex");
      const cached  = await _imgCacheGet(hash);

      if (cached) {
        imgMap.set(rawUrl, cached);
        emCache++;
        continue;
      }

      // Upload para o WP
      const filename    = path.basename(filePath);
      const data_base64 = data.toString("base64");
      const controller  = new AbortController();
      const timer       = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

      let publicUrl;
      try {
        const res = await fetch(`${CEIA_API_URL}/upload`, {
          method:  "POST",
          headers: { "X-Ceia-Token": token, "Content-Type": "application/json" },
          body:    JSON.stringify({ filename, hash, data_base64 }),
          signal:  controller.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.url) throw new Error(`HTTP ${res.status} — ${JSON.stringify(json).slice(0, 80)}`);
        publicUrl = json.url;
      } finally {
        clearTimeout(timer);
      }

      await _imgCacheSet(hash, publicUrl);
      imgMap.set(rawUrl, publicUrl);
      enviadas++;
    } catch (err) {
      console.error(`[VITRINE] falha ao subir imagem "${path.basename(rawUrl)}": ${err.message}`);
      imgMap.set(rawUrl, null);
      falhas++;
    }
  }

  console.log(`[VITRINE] imagens: ${enviadas} enviadas, ${emCache} já em cache, ${falhas} falhas`);
  return imgMap;
}

// ─── sincronizarVitrine — novo endpoint /sync (Camada 1 Vitrine) ──────────────
// Payload: { slug, nome, cardapio:[{categoria,produtos:[...]}], promocoes:[...] }
// Header: X-Ceia-Token (mesmo valor que CEIA_NODE_TOKEN)
// ⚠ Imagens: enviadas como foto_url/imagem (URL local http://127.0.0.1:PORT/uploads/...)
//   A vitrine deve tratar ausência graciosamente. Hospedagem pública = pendência Camada 2.
async function sincronizarVitrine() {
  const token = getToken();
  if (!token) {
    console.log("[VITRINE] desabilitada — configure CEIA_NODE_TOKEN");
    return null;
  }

  if (syncEmAndamento) {
    console.log("[VITRINE] sync já em andamento, ignorando");
    return null;
  }

  syncEmAndamento = true;

  try {
    // ── Lê config da loja em batch ────────────────────────────────────────
    // O plugin WP v0.2.0+ identifica a loja pelo token (X-Ceia-Token), não pelo slug.
    const CFG_KEYS = [
      'loja_nome','loja_telefone','loja_logo_url','loja_endereco','loja_cor_primaria',
      'loja_descricao','loja_slogan',
      'pag_cartao_online','pag_cartao','pag_pix_direto','pag_dinheiro','pix_modo',
      'horario_dom_ativo','horario_dom_ab','horario_dom_fe',
      'horario_seg_ativo','horario_seg_ab','horario_seg_fe',
      'horario_ter_ativo','horario_ter_ab','horario_ter_fe',
      'horario_qua_ativo','horario_qua_ab','horario_qua_fe',
      'horario_qui_ativo','horario_qui_ab','horario_qui_fe',
      'horario_sex_ativo','horario_sex_ab','horario_sex_fe',
      'horario_sab_ativo','horario_sab_ab','horario_sab_fe',
    ];
    const cfgRows  = await dbAll(
      `SELECT key, value FROM config WHERE key IN (${CFG_KEYS.map(() => '?').join(',')})`,
      CFG_KEYS
    );
    const cfg      = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));
    const lojaNome = cfg['loja_nome'] || '';

    // ── Leitura via lerCardapio() — mesma fonte que a tela de Cardápio ────
    const dados = await lerCardapio();
    const { categorias, produtos, adicionais: adicionaisLista, promocoes: promocoesPublicas } = dados;

    // ── Mapeia variações por produto (com preco_texto) ────────────────────
    const varsByProd = {};
    for (const p of produtos) {
      if (p.variacoes?.length) {
        varsByProd[p.id] = p.variacoes.map(v => ({
          id:          v.id,
          nome:        v.nome,
          preco:       _preco(v.preco),
          preco_texto: _fmtBRL(v.preco),
        }));
      }
    }

    // ── Índice de grupos de adicionais por ID ─────────────────────────────
    const adicionalById = new Map((adicionaisLista || []).map(a => [a.id, a]));

    // ── Agrupa produtos por categoria ─────────────────────────────────────
    const catById = {};
    for (const c of categorias) catById[c.id] = c;

    const prodsByCat = {};
    for (const p of produtos) {
      const catNome = catById[p.categoria_id]?.nome || 'Sem categoria';
      if (!prodsByCat[catNome]) prodsByCat[catNome] = [];
      const precoRaw = p.preco_promocional != null && p.preco_promocional > 0 ? p.preco_promocional : p.preco;
      const preco    = _preco(precoRaw);

      // Monta array de adicionais no formato esperado pelo plugin (v0.8.x)
      const adicionaisProd = (p.adicionais_grupos || [])
        .map(id => {
          const g = adicionalById.get(Number(id)); // coerce: pode vir string no JSON
          if (!g || !g.opcoes?.length) return null;
          const minEsc = Number(g.min_escolhas) || 0;
          // Regra contrato: obrigatorio=true e min_escolhas=0 → força min=1
          const min    = (g.obrigatorio && minEsc === 0) ? 1 : minEsc;
          const max    = Number(g.max_escolhas) || g.opcoes.length;
          return {
            nome:  g.nome,
            min,
            max,
            itens: g.opcoes.map(op => ({
              nome:  op.nome,
              preco: _preco(op.preco), // sempre Number com 2 casas — sem "JS:" nem dízima
            })),
          };
        })
        .filter(Boolean);

      const prodObj = {
        id:          p.id,
        nome:        p.nome,
        descricao:   p.descricao  || null,
        preco,
        preco_texto: _fmtBRL(preco),
        imagem:      p.foto_url   || null,
        esgotado:    p.esgotado   === true,
        variacoes:   varsByProd[p.id] || [],
      };
      if (adicionaisProd.length) prodObj.adicionais = adicionaisProd;
      prodsByCat[catNome].push(prodObj);
    }

    const cardapio = categorias
      .filter(c => prodsByCat[c.nome]?.length)
      .map(c => ({ categoria: c.nome, produtos: prodsByCat[c.nome] }));

    const promocoes = promocoesPublicas;

    // ── Campos de identidade da loja ──────────────────────────────────────
    const telefone     = _normalizeTelefone(cfg['loja_telefone']);
    const endereco     = cfg['loja_endereco'] || null;
    const aberto       = _calcAberto(cfg);
    const horarioTexto = _horarioTexto(cfg);
    const logoRaw      = cfg['loja_logo_url'] || null;

    // ── Resolve imagens locais → URLs públicas via upload WP ─────────────
    // Coleta todas as URLs locais únicas (logo + fotos de produtos)
    const urlsLocais = new Set();
    if (logoRaw && _isUrlLocal(logoRaw)) urlsLocais.add(logoRaw);
    for (const cat of cardapio) {
      for (const p of cat.produtos) {
        if (p.imagem && _isUrlLocal(p.imagem)) urlsLocais.add(p.imagem);
      }
    }
    // Promoções: mesmo tratamento das fotos de produto
    for (const promo of promocoes) {
      if (promo.imagem && _isUrlLocal(promo.imagem)) urlsLocais.add(promo.imagem);
    }

    const imgMap = urlsLocais.size > 0
      ? await _resolverImagensPublicas(urlsLocais, token)
      : new Map();

    // Substitui imagens locais por URLs públicas no cardápio
    for (const cat of cardapio) {
      for (const p of cat.produtos) {
        if (p.imagem && imgMap.has(p.imagem)) p.imagem = imgMap.get(p.imagem) ?? null;
      }
    }
    // Substitui imagens locais por URLs públicas nas promoções
    for (const promo of promocoes) {
      if (promo.imagem && imgMap.has(promo.imagem)) promo.imagem = imgMap.get(promo.imagem) ?? null;
    }

    // Logo pública (ou null se não subiu)
    const logo = logoRaw
      ? (imgMap.has(logoRaw) ? (imgMap.get(logoRaw) ?? null) : (_isUrlLocal(logoRaw) ? null : logoRaw))
      : null;

    // ── Cor do tema (loja_cor_primaria) — opcional, validação hex ────────
    const corRaw   = (cfg['loja_cor_primaria'] || '').trim();
    const corTema  = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(corRaw) ? corRaw : null;

    // ── Log diagnóstico antes do POST ─────────────────────────────────────
    const totalProdus   = cardapio.reduce((s, c) => s + c.produtos.length, 0);
    const totalComAdic  = cardapio.reduce((s, c) => s + c.produtos.filter(p => p.adicionais?.length).length, 0);
    const totalGrupos   = cardapio.reduce((s, c) => s + c.produtos.reduce((ss, p) => ss + (p.adicionais?.length || 0), 0), 0);
    console.log(`[VITRINE] sync: ${totalProdus} produtos, ${totalComAdic} com adicionais (${totalGrupos} grupos no total), ${promocoes.length} promoções`);
    console.log(`[VITRINE] loja: nome="${lojaNome}" tel="${telefone}" aberto=${aberto} horario="${horarioTexto}" endereco="${endereco}" logo="${logo}"`);
    console.log(`[VITRINE] cor_tema: ${corTema ?? '(omitida — plugin usará padrão)'}`);

    // ── Formas de pagamento habilitadas (PARTE 1) ─────────────────────────
    // Defaults espelham os defaults do UI (configuracoes.js tabPagamentos):
    //   pag_cartao_online → '0' se ausente   pag_cartao  → '1' se ausente
    //   pag_pix_direto    → '0' se ausente   pag_dinheiro → '1' se ausente
    const pagamentos = [
      (cfg['pag_cartao_online'] ?? '0') === '1' ? 'cartao_online'  : null,
      (cfg['pag_cartao']        ?? '1') === '1' ? 'cartao_entrega' : null,
      // PIX habilitado se: pag_pix_direto=1 (manual) OU pix_modo=asaas (Asaas)
      ((cfg['pag_pix_direto'] ?? '0') === '1' || (cfg['pix_modo'] ?? 'asaas') === 'asaas') ? 'pix' : null,
      (cfg['pag_dinheiro']      ?? '1') === '1' ? 'dinheiro'       : null,
    ].filter(Boolean);

    // ── Modo PIX (PARTE 2) ────────────────────────────────────────────────
    const pixModo = cfg['pix_modo'] === 'asaas' ? 'asaas' : 'manual';

    const slogan = cfg['loja_slogan'] || null;
    const sobre  = cfg['loja_descricao'] || null;

    const payload = { nome: lojaNome, telefone, logo, aberto, horario_texto: horarioTexto, endereco, cardapio, promocoes };
    if (slogan) payload.slogan = slogan;
    if (sobre)  payload.sobre  = sobre;
    if (corTema) payload.cor_tema = corTema;
    if (pagamentos.length) payload.pagamentos = pagamentos;
    payload.pix_modo = pixModo;

    // ── POST para /sync com X-Ceia-Token ──────────────────────────────────
    const url     = `${CEIA_API_URL}/sync`;
    const headers = { 'X-Ceia-Token': token, 'Content-Type': 'application/json' };
    console.log(`[VITRINE] URL: ${url}`);
    console.log(`[VITRINE] token (primeiros 8): ${token.slice(0, 8)}`);
    console.log(`[VITRINE] headers: ${JSON.stringify(headers)}`);

    const controller = new AbortController();
    const reqTimer   = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify(payload),
        signal:  controller.signal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') console.error(`[VITRINE] timeout (${TIMEOUT_MS / 1000}s) em /sync`);
      else console.error('[VITRINE] erro de rede em /sync:', fetchErr.message);
      console.error("[VITRINE] sync falhou — tentará de novo em 60s");
      setTimeout(sincronizarVitrine, 60_000);
      return null;
    } finally {
      clearTimeout(reqTimer);
    }

    const corpo = await res.text().catch(() => '');
    console.log(`[VITRINE] status resposta: ${res.status}`);
    console.log(`[VITRINE] corpo resposta: ${corpo.slice(0, 300)}`);

    if (res.status === 401 || res.status === 403) {
      console.error(`[VITRINE] token recusado (HTTP ${res.status}) — reconfigura em Configurações → Vitrine`);
      return null;
    }
    if (!res.ok) {
      console.error(`[VITRINE] erro HTTP ${res.status} em /sync`);
      return null;
    }

    // ── Extrai e persiste URL pública da vitrine (campo `url` vem na resposta do Hub) ──
    try {
      const dados = JSON.parse(corpo);
      const urlPublica = dados.url || null;
      if (urlPublica) {
        // TODO(causa-2): considerar propagar/alertar — falha aqui perde URL pública da vitrine, cliente não acessa o link
        await dbRun("INSERT OR REPLACE INTO config (key,value) VALUES ('vitrine_url',?)", [urlPublica]).catch(e => console.error('[VITRINE] falha em INSERT config(vitrine_url):', e.message));
        console.log(`[VITRINE-SYNC] url pública (do Hub) = ${urlPublica} → salva`);
      } else {
        console.log('[VITRINE-SYNC] resposta sem campo url — aguardando plugin atualizado no Hub');
      }
    } catch (_) { /* corpo não é JSON válido — ignora */ }

    const stats = {
      ts:         new Date().toISOString(),
      categorias: cardapio.length,
      produtos:   totalProdus,
      promocoes:  promocoes.length,
    };
    ultimoSync = stats;
    await salvarUltimoSync(stats);
    console.log(`[VITRINE] sync OK — ${JSON.stringify(stats)}`);
    ceiaEmitter.emit("ceia:sync-ok", stats);
    return stats;

  } catch (err) {
    console.error("[VITRINE] erro inesperado no sync:", err.message);
    return null;
  } finally {
    syncEmAndamento = false;
  }
}

async function salvarUltimoSync(stats) {
  const valor = JSON.stringify({ ts: new Date().toISOString(), ...stats });
  db.run(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('ultimo_sync_cardapio', ?)",
    [valor]
  );
}

// ─── syncCardapio ─────────────────────────────────────────────────────────────
async function syncCardapio() {
  const token = getToken();
  if (!token) {
    console.log("[CEIA] vitrine desabilitada — configure CEIA_NODE_TOKEN");
    return null;
  }

  if (syncEmAndamento) {
    console.log("[CEIA] sync já em andamento, ignorando");
    return null;
  }

  syncEmAndamento = true;

  try {
    const payload = await lerCardapio();

    const res = await vitrineFetch("/node/sync-cardapio", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!res) {
      console.error("[CEIA] sync falhou — tentará de novo em 60s");
      setTimeout(syncCardapio, 60_000);
      return null;
    }

    ultimoSync = {
      ts: new Date().toISOString(),
      categorias: payload.categorias.length,
      produtos: payload.produtos.length,
      bairros: payload.bairros.length,
      promocoes: payload.promocoes.length,
    };

    await salvarUltimoSync(ultimoSync);
    console.log(`[CEIA] cardápio sincronizado: ${JSON.stringify(ultimoSync)}`);
    ceiaEmitter.emit("ceia:sync-ok", ultimoSync);
    return ultimoSync;
  } catch (err) {
    console.error("[CEIA] erro inesperado no sync:", err.message);
    return null;
  } finally {
    syncEmAndamento = false;
  }
}

// ─── Disparador unificado com debounce + reentrância ─────────────────────────
// Ponto único de entrada para todos os auto-syncs. Colapsa rajadas de edição
// num único envio (debounce 4s). Se um sync já estiver em andamento quando o
// timer disparar, marca pendente e reenvía uma vez ao terminar.
let _syncDebounceTimer = null;
let _syncPendente      = false;

function agendarSyncVitrine(motivo) {
  if (!getToken()) return; // no-op silencioso sem token configurado

  // Reinicia o timer a cada chamada (colapsa rajadas)
  if (_syncDebounceTimer) clearTimeout(_syncDebounceTimer);

  _syncDebounceTimer = setTimeout(async () => {
    _syncDebounceTimer = null;

    // Outro sync em andamento: enfileira para rodar ao terminar
    if (syncEmAndamento) {
      _syncPendente = true;
      console.log(`[VITRINE-SYNC] auto (${motivo}) → enfileirado (sync em andamento)`);
      return;
    }

    _syncPendente = false;
    try {
      await sincronizarVitrine();
      console.log(`[VITRINE-SYNC] auto (${motivo}) → enviado`);
    } catch (e) {
      console.warn(`[VITRINE-SYNC] auto (${motivo}) falhou:`, e.message);
    }

    // Reenvía se ficou algo pendente durante este sync
    if (_syncPendente) {
      _syncPendente = false;
      sincronizarVitrine()
        .then(() => console.log('[VITRINE-SYNC] auto (pendente) → enviado'))
        .catch(e => console.warn('[VITRINE-SYNC] auto (pendente) falhou:', e.message));
    }
  }, DEBOUNCE_MS);
}

// Adaptadores para eventos do ceiaEmitter (mantém retrocompatibilidade)
function onCardapioChanged() { agendarSyncVitrine('cardapio'); }
function onPausaChanged()    { agendarSyncVitrine('esgotado'); }

// ─── startVitrineSync ─────────────────────────────────────────────────────────
function startVitrineSync() {
  // Sync de boot: garante que a vitrine reflita o estado atual após edições offline
  setTimeout(() => {
    sincronizarVitrine()
      .then(s => { if (s) console.log('[VITRINE-SYNC] boot → enviado'); })
      .catch(e => console.warn('[VITRINE-SYNC] boot falhou:', e.message));
  }, 3_000);

  // Heartbeat a cada 5min
  syncTimer = setInterval(sincronizarVitrine, SYNC_INTERVAL_MS);

  // Escuta mudanças no cardápio e nas promoções públicas
  ceiaEmitter.on("ceia:cardapio-changed", onCardapioChanged);
  ceiaEmitter.on("ceia:produto-pausado",  onPausaChanged);

  console.log("[VITRINE] sync automático iniciada");
}

function getSyncStatus() {
  return {
    ultimoSync,
    emAndamento: syncEmAndamento,
    tokenConfigurado: !!getToken(),
  };
}

module.exports = {
  vitrineFetch,
  syncCardapio,
  sincronizarVitrine,
  startVitrineSync,
  getSyncStatus,
  agendarSyncVitrine,
  obterSlug: _obterSlug,
};
