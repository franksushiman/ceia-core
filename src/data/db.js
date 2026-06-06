const sqlite3 = require("sqlite3").verbose();
const path    = require("path");
const { ceiaEmitter } = require("../services/ceia-emitter");

const db = new sqlite3.Database(path.join(process.cwd(), "ceia.db"));

// ── SQLite: WAL mode + busy retry ─────────────────────────────────────────────
// WAL permite leituras concorrentes sem bloquear escritas.
// busy_timeout faz o driver retentar automaticamente por até 5 s antes de lançar SQLITE_BUSY.
db.run("PRAGMA journal_mode=WAL", (err) => {
  if (err) console.error("[DB] Erro ao ativar WAL:", err.message);
});
db.run("PRAGMA busy_timeout=5000");
db.get("PRAGMA journal_mode", (err, row) => {
  if (err) console.error("[DB] Erro ao verificar journal_mode:", err.message);
  else console.log(`[DB] journal_mode ativo: ${row.journal_mode}`);
});

db.serialize(() => {
  // ── Tabelas originais ──────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT,
      items TEXT,
      total REAL,
      status TEXT,
      origin TEXT,
      ceia_codigo TEXT,
      frota_pedido_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      coordinates_json TEXT,
      shipping_fee REAL,
      minimum_order REAL,
      prep_time INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Cardápio digital ───────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      ordem INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria_id INTEGER,
      nome TEXT NOT NULL,
      descricao TEXT,
      preco REAL NOT NULL,
      preco_promocional REAL,
      foto_url TEXT,
      ativo INTEGER DEFAULT 1,
      FOREIGN KEY (categoria_id) REFERENCES categorias(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS adicionais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo TEXT DEFAULT 'multiplo',
      obrigatorio INTEGER DEFAULT 0,
      min_escolhas INTEGER DEFAULT 0,
      max_escolhas INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS adicionais_opcoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adicional_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      preco REAL DEFAULT 0,
      FOREIGN KEY (adicional_id) REFERENCES adicionais(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS produto_adicionais (
      produto_id INTEGER NOT NULL,
      adicional_id INTEGER NOT NULL,
      PRIMARY KEY (produto_id, adicional_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bairros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      taxa REAL DEFAULT 0,
      tempo_min INTEGER DEFAULT 30,
      tempo_max INTEGER DEFAULT 60,
      ativo INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // ── Fase 5a — Variações de preço ──────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS variacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      preco REAL NOT NULL DEFAULT 0,
      ordem INTEGER DEFAULT 0,
      FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
    )
  `);

  // ── Fase 6 — Zonas de Entrega ─────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS zonas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      geometria TEXT NOT NULL,
      taxa REAL NOT NULL DEFAULT 0,
      tempo_min INTEGER DEFAULT 30,
      tempo_max INTEGER DEFAULT 60,
      cor TEXT DEFAULT '#00d0b7',
      ativa INTEGER DEFAULT 1,
      ordem INTEGER DEFAULT 0,
      criada_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Fase 8 — Despacho ────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS motoboys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefone TEXT,
      status TEXT DEFAULT 'ativo',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pacotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'montando',
      motoboy_id INTEGER,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      despachado_em DATETIME,
      coletado_em DATETIME,
      finalizado_em DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      cliente_nome TEXT,
      cliente_whatsapp TEXT,
      endereco TEXT,
      bairro TEXT,
      complemento TEXT,
      itens TEXT,
      subtotal REAL DEFAULT 0,
      taxa_entrega REAL DEFAULT 0,
      total REAL DEFAULT 0,
      forma_pagamento TEXT,
      origem TEXT DEFAULT 'manual',
      status TEXT DEFAULT 'preparacao',
      asaas_payment_id TEXT,
      pacote_id INTEGER,
      motoboy_id INTEGER,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      finalizado_em DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS estornos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      valor REAL NOT NULL,
      motivo TEXT,
      asaas_refund_id TEXT,
      status TEXT DEFAULT 'pendente',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
    )
  `);

  // Fase 8 migrations
  const _m8 = () => {};
  db.run(`ALTER TABLE pedidos ADD COLUMN lat REAL`, _m8);
  db.run(`ALTER TABLE pedidos ADD COLUMN lng REAL`, _m8);

  // Fase 9 — Motoboys fleet completo
  const _m9 = () => {};
  db.run(`ALTER TABLE motoboys ADD COLUMN telegram_id TEXT`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN whatsapp TEXT`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN cpf TEXT`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN vinculo TEXT DEFAULT 'Fixo'`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN veiculo TEXT DEFAULT 'Moto'`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN pix TEXT`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN operacional_status TEXT DEFAULT 'OFFLINE'`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN pagamento_pendente INTEGER DEFAULT 0`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN saldo_acerto REAL DEFAULT 0`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN no_nome TEXT`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN lat REAL`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN lng REAL`, _m9);
  db.run(`ALTER TABLE motoboys ADD COLUMN ultima_atualizacao DATETIME`, _m9);

  // Fase Bot-1 — Schema para integração bot Telegram (idempotente, falha silenciosa)
  const _mBot = () => {};
  db.run(`ALTER TABLE motoboys ADD COLUMN pendente_desde DATETIME`, _mBot);
  db.run(`ALTER TABLE motoboys ADD COLUMN no_url TEXT`, _mBot);
  db.run(`ALTER TABLE motoboys ADD COLUMN taxa_deslocamento REAL DEFAULT 0`, _mBot);
  db.run(`ALTER TABLE motoboys ADD COLUMN distancia_km REAL DEFAULT 0`, _mBot);
  db.run(`ALTER TABLE pedidos ADD COLUMN codigo_entrega TEXT`, _mBot);
  // Fase Bot-obs — campo de observações do pedido
  const _mObs = () => {};
  db.run(`ALTER TABLE pedidos ADD COLUMN observacoes TEXT`, _mObs);
  // Pagamento offline — troco e bandeira (NULLABLE — linhas antigas ficam válidas com NULL)
  const _mOff = () => {};
  db.run(`ALTER TABLE pedidos ADD COLUMN troco_para REAL`, _mOff);
  db.run(`ALTER TABLE pedidos ADD COLUMN bandeira_cartao TEXT`, _mOff);
  // Limpeza de carrinhos residuais de testes/sessões antigas (idempotente)
  db.run(`UPDATE conversas_wa SET carrinho = '[]' WHERE carrinho IS NOT NULL AND carrinho != '[]'`, () => {});
  // Índice parcial: permite múltiplos NULL, mas telegram_id preenchido é único
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_motoboys_telegram_id ON motoboys(telegram_id) WHERE telegram_id IS NOT NULL`, _mBot);
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens_cadastro (
      token TEXT PRIMARY KEY,
      usado INTEGER DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, _mBot);
  db.run(`
    CREATE TABLE IF NOT EXISTS entregas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      motoboy_id INTEGER,
      motoboy_telegram_id TEXT,
      origem TEXT DEFAULT 'local',
      no_origem TEXT,
      pedido_id INTEGER,
      valor_entrega REAL DEFAULT 0,
      taxa_deslocamento REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDENTE',
      data DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (motoboy_id) REFERENCES motoboys(id),
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
    )
  `, _mBot);
  db.run(`
    CREATE TABLE IF NOT EXISTS historico_motoboys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      motoboy_id INTEGER NOT NULL,
      tipo TEXT,
      valor REAL,
      descricao TEXT,
      data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (motoboy_id) REFERENCES motoboys(id)
    )
  `, _mBot);

  // Fase Bot-4 — SOS + Chat com cliente (idempotente)
  db.run(`CREATE TABLE IF NOT EXISTS chat_sessoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL UNIQUE,
    tipo TEXT NOT NULL,
    telefone_cliente TEXT,
    nome_cliente TEXT,
    pedido_id INTEGER,
    iniciado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, _mBot);

  // Fase WA-2a — histórico de conversas WhatsApp + carrinho
  db.run(`CREATE TABLE IF NOT EXISTS conversas_wa (
    numero TEXT PRIMARY KEY,
    historico TEXT,
    carrinho TEXT,
    modo_manual INTEGER DEFAULT 0,
    ultima_interacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {});

  // Fase WA-2c — Memória de clientes recorrentes
  db.run(`CREATE TABLE IF NOT EXISTS clientes_wa (
    numero TEXT PRIMARY KEY,
    nome TEXT,
    ultimo_endereco TEXT,
    ultimo_lat REAL,
    ultimo_lng REAL,
    ultima_zona TEXT,
    total_pedidos INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {});

  // Fase WA-2b — Chamados de atendimento humano
  db.run(`CREATE TABLE IF NOT EXISTS chamados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    nome_cliente TEXT,
    motivo TEXT,
    status TEXT DEFAULT 'aberto',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolvido_em DATETIME
  )`, () => {});

  // Fase 2 / 3 / 5a migrations (silent fail on duplicate column)
  const _m = () => {};
  db.run(`ALTER TABLE categorias ADD COLUMN oculto INTEGER DEFAULT 0`, _m);
  db.run(`ALTER TABLE categorias ADD COLUMN criado_em DATETIME DEFAULT CURRENT_TIMESTAMP`, _m);
  db.run(`ALTER TABLE produtos ADD COLUMN esgotado INTEGER DEFAULT 0`, _m);
  db.run(`ALTER TABLE produtos ADD COLUMN adicionais_grupos TEXT`, _m);
  db.run(`ALTER TABLE produtos ADD COLUMN criado_em DATETIME DEFAULT CURRENT_TIMESTAMP`, _m);
  db.run(`ALTER TABLE produtos ADD COLUMN ordem INTEGER DEFAULT 0`, _m);
  db.run(`ALTER TABLE categorias ADD COLUMN descricao TEXT`, _m);
  db.run(`ALTER TABLE categorias ADD COLUMN impressora_id TEXT`, _m);
  db.run(`ALTER TABLE categorias ADD COLUMN horarios_especificos INTEGER DEFAULT 0`, _m);
  db.run(`ALTER TABLE categorias ADD COLUMN horarios TEXT`, _m);
  db.run(`ALTER TABLE adicionais ADD COLUMN ordem INTEGER DEFAULT 0`, _m);
  db.run(`ALTER TABLE adicionais ADD COLUMN criado_em DATETIME DEFAULT CURRENT_TIMESTAMP`, _m);
  db.run(`ALTER TABLE produtos ADD COLUMN tem_variacoes INTEGER DEFAULT 0`, _m);

  // Marketing Fase 2 — tabela de promoções e cupons
  db.run(`CREATE TABLE IF NOT EXISTS promocoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    nome TEXT NOT NULL,
    codigo TEXT,
    descricao TEXT,
    beneficio_tipo TEXT NOT NULL,
    beneficio_valor REAL,
    min_pedidos INTEGER,
    dias_sem_pedir INTEGER,
    min_total_gasto REAL,
    min_ticket_medio REAL,
    formas_pagamento TEXT,
    zonas_excluidas TEXT,
    valor_minimo_pedido REAL,
    dias_semana TEXT,
    hora_inicio TEXT,
    hora_fim TEXT,
    ativa INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {});

  // Marketing Fase 2.5 — visibilidade + imagem (silent migrations)
  db.run(`ALTER TABLE promocoes ADD COLUMN visibilidade TEXT DEFAULT 'segmentada'`, _m);
  db.run(`ALTER TABLE promocoes ADD COLUMN imagem TEXT`, _m);

  // Marketing Fase 3 — desconto no pedido (silent migrations)
  db.run(`ALTER TABLE pedidos ADD COLUMN promocao_id INTEGER`, _m);
  db.run(`ALTER TABLE pedidos ADD COLUMN desconto_aplicado REAL DEFAULT 0`, _m);
  // Endereço validado (geocode/reverse geocode) — separado do texto cru do cliente
  db.run(`ALTER TABLE pedidos ADD COLUMN endereco_formatado TEXT`, _m);

  // Marketing Fase 1 — histórico agregado de clientes WA (idempotente)
  const _mMkt1 = () => {};
  db.run(`ALTER TABLE clientes_wa ADD COLUMN total_gasto REAL DEFAULT 0`, _mMkt1);
  db.run(`ALTER TABLE clientes_wa ADD COLUMN ticket_medio REAL DEFAULT 0`, _mMkt1);
  db.run(`ALTER TABLE clientes_wa ADD COLUMN ultimo_pedido_em DATETIME`, _mMkt1);
  db.run(`ALTER TABLE clientes_wa ADD COLUMN forma_pagamento_frequente TEXT`, _mMkt1);
  db.run(`ALTER TABLE clientes_wa ADD COLUMN zona_frequente TEXT`, _mMkt1);

  // Fase Asaas — config defaults (idempotente via INSERT OR IGNORE)
  const _mAsaas = () => {};
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('asaas_env', 'producao')`, _mAsaas);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('pix_modo', 'asaas')`, _mAsaas);

  // Clientes Recentes — painel de histórico por cliente WhatsApp
  db.run(`CREATE TABLE IF NOT EXISTS clientes_ocultos (
    whatsapp TEXT PRIMARY KEY,
    oculto_em DATETIME NOT NULL
  )`, () => {});

  // Thread de chat humano — persiste msgs trocadas em atendimentos
  db.run(`CREATE TABLE IF NOT EXISTS mensagens_wa_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    de TEXT NOT NULL,
    texto TEXT NOT NULL,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_mwa_chat_numero ON mensagens_wa_chat(numero, criado_em)`, () => {});
  // msgs_nao_lidas: contador para badge de atendimentos pendentes
  db.run(`ALTER TABLE conversas_wa ADD COLUMN msgs_nao_lidas INTEGER DEFAULT 0`, () => {});
  // Avaliação de entrega pelo cliente (1-5, NULL até o cliente responder)
  db.run(`ALTER TABLE pedidos ADD COLUMN avaliacao_entrega INTEGER`, () => {});
});

// ─── helpers internos ─────────────────────────────────────────────────────────
function run(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    })
  );
}

function all(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

function get(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function emitCardapioChanged() {
  ceiaEmitter.emit("ceia:cardapio-changed");
}

// ─── Orders ──────────────────────────────────────────────────────────────────
function createOrder(order) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO orders (customer_phone, items, total, status, origin, ceia_codigo, frota_pedido_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        order.customer_phone,
        JSON.stringify(order.items),
        order.total,
        order.status,
        order.origin,
        order.ceia_codigo || null,
        order.frota_pedido_id || null,
      ],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

// ─── Categorias ──────────────────────────────────────────────────────────────
async function getCategorias() {
  return all("SELECT * FROM categorias WHERE ativo = 1 ORDER BY ordem");
}

async function saveCategoria(data) {
  if (data.id) {
    await run(
      "UPDATE categorias SET nome = ?, ordem = ? WHERE id = ?",
      [data.nome, data.ordem ?? 0, data.id]
    );
  } else {
    await run(
      "INSERT INTO categorias (nome, ordem) VALUES (?, ?)",
      [data.nome, data.ordem ?? 0]
    );
  }
  emitCardapioChanged();
}

async function deleteCategoria(id) {
  await run("UPDATE categorias SET ativo = 0 WHERE id = ?", [id]);
  emitCardapioChanged();
}

async function reorderCategorias(ids) {
  for (let i = 0; i < ids.length; i++) {
    await run("UPDATE categorias SET ordem = ? WHERE id = ?", [i, ids[i]]);
  }
}

// ─── Produtos ─────────────────────────────────────────────────────────────────
async function getProdutos() {
  return all("SELECT * FROM produtos WHERE ativo = 1 ORDER BY categoria_id, id");
}

// Retorna todos os produtos ativos com categoria_nome, variações e adicionais (para autocomplete/despacho)
async function getProdutosTodos() {
  const prods = await all(
    `SELECT p.id, p.nome, p.preco, p.tem_variacoes, p.esgotado,
            p.adicionais_grupos,
            c.nome AS categoria_nome,
            (SELECT MIN(v.preco) FROM variacoes v WHERE v.produto_id = p.id) AS preco_min_var
     FROM produtos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.ativo = 1 AND (c.ativo IS NULL OR c.ativo = 1)
     ORDER BY c.nome, p.nome`
  );
  const vars = await all(
    `SELECT v.produto_id, v.nome, v.preco FROM variacoes v
     INNER JOIN produtos p ON p.id = v.produto_id AND p.ativo = 1
     ORDER BY v.ordem, v.id`
  );
  const adicionaisRaw = await all(
    `SELECT a.id, a.nome, ao.nome AS opcao_nome, ao.preco AS opcao_preco
     FROM adicionais a
     LEFT JOIN adicionais_opcoes ao ON ao.adicional_id = a.id
     ORDER BY a.id, ao.id`
  );
  const varMap = {};
  for (const v of vars) {
    if (!varMap[v.produto_id]) varMap[v.produto_id] = [];
    varMap[v.produto_id].push({ nome: v.nome, preco: v.preco });
  }
  const adicMap = {};
  for (const a of adicionaisRaw) {
    if (!adicMap[a.id]) adicMap[a.id] = { id: a.id, nome: a.nome, opcoes: [] };
    if (a.opcao_nome) adicMap[a.id].opcoes.push({ nome: a.opcao_nome, preco: a.opcao_preco || 0 });
  }
  return prods.map(p => {
    const gruposIds = (() => { try { return JSON.parse(p.adicionais_grupos || '[]'); } catch (_) { return []; } })();
    return {
      ...p,
      variacoes:  varMap[p.id] || [],
      adicionais: gruposIds.map(id => adicMap[id]).filter(Boolean),
    };
  });
}

async function saveProduto(data) {
  if (data.id) {
    await run(
      `UPDATE produtos SET categoria_id=?, nome=?, descricao=?, preco=?,
       preco_promocional=?, foto_url=? WHERE id=?`,
      [data.categoria_id, data.nome, data.descricao, data.preco,
       data.preco_promocional || null, data.foto_url || null, data.id]
    );
  } else {
    const { lastID } = await run(
      `INSERT INTO produtos (categoria_id, nome, descricao, preco, preco_promocional, foto_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.categoria_id, data.nome, data.descricao, data.preco,
       data.preco_promocional || null, data.foto_url || null]
    );
    data.id = lastID;
  }

  // Atualiza adicionais vinculados
  if (Array.isArray(data.adicionais_ids)) {
    await run("DELETE FROM produto_adicionais WHERE produto_id = ?", [data.id]);
    for (const aid of data.adicionais_ids) {
      await run(
        "INSERT OR IGNORE INTO produto_adicionais (produto_id, adicional_id) VALUES (?, ?)",
        [data.id, aid]
      );
    }
  }

  emitCardapioChanged();
}

async function deleteProduto(id) {
  await run("UPDATE produtos SET ativo = 0 WHERE id = ?", [id]);
  emitCardapioChanged();
}

// ─── Produtos Fase 3 ─────────────────────────────────────────────────────────
async function getProdutosByCategoria(categoriaId) {
  return all(
    `SELECT p.*,
       (SELECT MIN(v.preco) FROM variacoes v WHERE v.produto_id = p.id) AS preco_min_var
     FROM produtos p
     WHERE p.categoria_id = ? AND p.ativo = 1
     ORDER BY p.ordem, p.id`,
    [categoriaId]
  );
}

async function patchProduto(id, fields) {
  const allowed = ["nome","descricao","preco","preco_promocional","foto_url","esgotado","ativo","categoria_id","ordem","tem_variacoes"];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
  }
  // adicionais_grupos is a JSON TEXT column — special handling
  if (fields.adicionais_grupos !== undefined) {
    sets.push("adicionais_grupos = ?");
    vals.push(JSON.stringify(Array.isArray(fields.adicionais_grupos) ? fields.adicionais_grupos : []));
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE produtos SET ${sets.join(", ")} WHERE id = ?`, vals);
  emitCardapioChanged();
}

async function reorderProdutos(ids) {
  for (let i = 0; i < ids.length; i++) {
    await run("UPDATE produtos SET ordem = ? WHERE id = ?", [i, ids[i]]);
  }
  emitCardapioChanged();
}

async function duplicarProduto(id) {
  const p = await get("SELECT * FROM produtos WHERE id = ?", [id]);
  if (!p) throw new Error("Produto não encontrado");
  const maxR = await get("SELECT MAX(ordem) as m FROM produtos WHERE categoria_id = ? AND ativo = 1", [p.categoria_id]);
  const { lastID } = await run(
    `INSERT INTO produtos (categoria_id, nome, descricao, preco, preco_promocional, foto_url, esgotado, ordem)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [p.categoria_id, p.nome + " (cópia)", p.descricao, p.preco,
     p.preco_promocional, p.foto_url, (maxR?.m ?? 0) + 1]
  );
  emitCardapioChanged();
  return get("SELECT * FROM produtos WHERE id = ?", [lastID]);
}

async function moverProduto(id, categoriaId) {
  const maxR = await get(
    "SELECT MAX(ordem) as m FROM produtos WHERE categoria_id = ? AND ativo = 1",
    [categoriaId]
  );
  await run("UPDATE produtos SET categoria_id = ?, ordem = ? WHERE id = ?",
    [categoriaId, (maxR?.m ?? 0) + 1, id]);
  emitCardapioChanged();
}

// ─── Adicionais ──────────────────────────────────────────────────────────────
async function getAdicionais() {
  const grupos = await all("SELECT * FROM adicionais ORDER BY id");
  const opcoes = await all("SELECT * FROM adicionais_opcoes ORDER BY adicional_id, id");
  const opcoesPorGrupo = {};
  for (const op of opcoes) {
    if (!opcoesPorGrupo[op.adicional_id]) opcoesPorGrupo[op.adicional_id] = [];
    opcoesPorGrupo[op.adicional_id].push(op);
  }
  return grupos.map((g) => ({ ...g, opcoes: opcoesPorGrupo[g.id] || [] }));
}

async function saveAdicional(data) {
  if (data.id) {
    await run(
      "UPDATE adicionais SET nome=?, tipo=?, obrigatorio=?, min_escolhas=?, max_escolhas=? WHERE id=?",
      [data.nome, data.tipo, data.obrigatorio ? 1 : 0,
       data.min_escolhas, data.max_escolhas, data.id]
    );
    await run("DELETE FROM adicionais_opcoes WHERE adicional_id = ?", [data.id]);
  } else {
    const { lastID } = await run(
      "INSERT INTO adicionais (nome, tipo, obrigatorio, min_escolhas, max_escolhas) VALUES (?,?,?,?,?)",
      [data.nome, data.tipo || "multiplo", data.obrigatorio ? 1 : 0,
       data.min_escolhas || 0, data.max_escolhas || 1]
    );
    data.id = lastID;
  }

  for (const op of data.opcoes || []) {
    await run(
      "INSERT INTO adicionais_opcoes (adicional_id, nome, preco) VALUES (?,?,?)",
      [data.id, op.nome, op.preco || 0]
    );
  }

  emitCardapioChanged();
}

async function deleteAdicional(id) {
  // Remove this ID from adicionais_grupos JSON arrays in produtos
  const prods = await all(
    "SELECT id, adicionais_grupos FROM produtos WHERE adicionais_grupos IS NOT NULL AND adicionais_grupos != ''"
  );
  for (const p of prods) {
    try {
      const grupos = JSON.parse(p.adicionais_grupos || "[]");
      const filtered = grupos.filter(gid => Number(gid) !== Number(id));
      if (filtered.length !== grupos.length) {
        await run("UPDATE produtos SET adicionais_grupos = ? WHERE id = ?", [JSON.stringify(filtered), p.id]);
      }
    } catch (_) {}
  }
  await run("DELETE FROM adicionais WHERE id = ?", [id]);
  emitCardapioChanged();
}

// ─── Variações de preço ───────────────────────────────────────────────────────
async function getVariacoesByProduto(produtoId) {
  return all(
    "SELECT * FROM variacoes WHERE produto_id = ? ORDER BY ordem, id",
    [produtoId]
  );
}

async function saveVariacao(data) {
  if (data.id) {
    await run("UPDATE variacoes SET nome = ?, preco = ? WHERE id = ?",
      [data.nome, data.preco ?? 0, data.id]);
    emitCardapioChanged();
    return get("SELECT * FROM variacoes WHERE id = ?", [data.id]);
  } else {
    const maxR = await get(
      "SELECT MAX(ordem) as m FROM variacoes WHERE produto_id = ?",
      [data.produto_id]
    );
    const { lastID } = await run(
      "INSERT INTO variacoes (produto_id, nome, preco, ordem) VALUES (?, ?, ?, ?)",
      [data.produto_id, data.nome, data.preco ?? 0, (maxR?.m ?? -1) + 1]
    );
    emitCardapioChanged();
    return get("SELECT * FROM variacoes WHERE id = ?", [lastID]);
  }
}

async function deleteVariacao(id) {
  await run("DELETE FROM variacoes WHERE id = ?", [id]);
  emitCardapioChanged();
}

async function reorderVariacoes(ids) {
  for (let i = 0; i < ids.length; i++) {
    await run("UPDATE variacoes SET ordem = ? WHERE id = ?", [i, ids[i]]);
  }
  emitCardapioChanged();
}

// ─── Bairros ─────────────────────────────────────────────────────────────────
async function getBairros() {
  return all("SELECT * FROM bairros WHERE ativo = 1 ORDER BY nome");
}

async function saveBairro(data) {
  if (data.id) {
    await run(
      "UPDATE bairros SET nome=?, taxa=?, tempo_min=?, tempo_max=? WHERE id=?",
      [data.nome, data.taxa, data.tempo_min, data.tempo_max, data.id]
    );
  } else {
    await run(
      "INSERT INTO bairros (nome, taxa, tempo_min, tempo_max) VALUES (?,?,?,?)",
      [data.nome, data.taxa, data.tempo_min || 30, data.tempo_max || 60]
    );
  }
  emitCardapioChanged();
}

async function deleteBairro(id) {
  await run("UPDATE bairros SET ativo = 0 WHERE id = ?", [id]);
  emitCardapioChanged();
}

// ─── Zonas de Entrega ─────────────────────────────────────────────────────────
async function getZonas() {
  return all("SELECT * FROM zonas ORDER BY ordem, id");
}

async function saveZona(data) {
  const geo = typeof data.geometria === 'string' ? data.geometria : JSON.stringify(data.geometria);
  if (data.id) {
    const allowed = ['nome','tipo','taxa','tempo_min','tempo_max','cor','ativa','ordem'];
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(data)) {
      if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
    }
    if (data.geometria !== undefined) { sets.push('geometria = ?'); vals.push(geo); }
    if (!sets.length) return;
    vals.push(data.id);
    await run(`UPDATE zonas SET ${sets.join(', ')} WHERE id = ?`, vals);
  } else {
    const { lastID } = await run(
      `INSERT INTO zonas (nome, tipo, geometria, taxa, tempo_min, tempo_max, cor, ativa, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.nome, data.tipo, geo, data.taxa ?? 0, data.tempo_min ?? 30, data.tempo_max ?? 60,
       data.cor || '#00d0b7', data.ativa ?? 1, data.ordem ?? 0]
    );
    data.id = lastID;
  }
  ceiaEmitter.emit('ceia:zonas-changed');
  return get('SELECT * FROM zonas WHERE id = ?', [data.id]);
}

async function deleteZona(id) {
  await run('DELETE FROM zonas WHERE id = ?', [id]);
  ceiaEmitter.emit('ceia:zonas-changed');
}

async function reorderZonas(ids) {
  for (let i = 0; i < ids.length; i++) {
    await run('UPDATE zonas SET ordem = ? WHERE id = ?', [i, ids[i]]);
  }
  ceiaEmitter.emit('ceia:zonas-changed');
}

// ─── Motoboys ─────────────────────────────────────────────────────────────────
async function getMotoboys(somenteAtivos = false) {
  // Despacho usa esta função — filtra por status='ativo' E operacional_status != OFFLINE
  if (somenteAtivos) {
    return all(`SELECT * FROM motoboys WHERE status = 'ativo' AND operacional_status IN ('ONLINE','EM_ROTA') ORDER BY nome`);
  }
  return all(`SELECT * FROM motoboys WHERE status = 'ativo' ORDER BY nome`);
}

async function getMotoboysFleet() {
  return all(`SELECT * FROM motoboys ORDER BY nome`);
}

async function getMotoboy(id) {
  return get(`SELECT * FROM motoboys WHERE id = ?`, [id]);
}

async function saveMotoboy(data) {
  if (data.id) {
    const allowed = ['nome','telefone','status','whatsapp','cpf','vinculo','veiculo','pix',
                     'operacional_status','pagamento_pendente','saldo_acerto','no_nome',
                     'lat','lng','ultima_atualizacao','telegram_id'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (data[k] !== undefined) { sets.push(`${k}=?`); vals.push(data[k]); }
    }
    if (sets.length) {
      vals.push(data.id);
      await run(`UPDATE motoboys SET ${sets.join(',')} WHERE id=?`, vals);
    }
  } else {
    const { lastID } = await run(
      `INSERT INTO motoboys (nome, telefone, status, whatsapp, cpf, vinculo, veiculo, pix, operacional_status, telegram_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [data.nome, data.telefone || null, data.status || 'ativo',
       data.whatsapp || null, data.cpf || null,
       data.vinculo || 'Fixo', data.veiculo || 'Moto',
       data.pix || null, data.operacional_status || 'OFFLINE',
       data.telegram_id || null]
    );
    data.id = lastID;
  }
  return get(`SELECT * FROM motoboys WHERE id = ?`, [data.id]);
}

async function deleteMotoboy(id) {
  const m = await get('SELECT telegram_id, saldo_acerto, pagamento_pendente FROM motoboys WHERE id = ?', [id]);
  if (!m) throw new Error('Motoboy não encontrado');

  // Verifica saldo pendente via tabela entregas (motoboys com Telegram)
  let pendentes = 0;
  if (m.telegram_id) {
    const row = await get(
      `SELECT COUNT(*) AS cnt FROM entregas
       WHERE status = 'PENDENTE' AND (motoboy_id = ? OR motoboy_telegram_id = ?)`,
      [id, m.telegram_id]
    );
    pendentes = row?.cnt || 0;
  }
  // Fallback para motoboys legados sem telegram_id (saldo vive em motoboys.saldo_acerto)
  if (pendentes === 0 && (+(m.saldo_acerto) > 0 || m.pagamento_pendente)) {
    pendentes = 1;
  }

  if (pendentes > 0) {
    throw new Error('Não é possível excluir motoboy com saldo de acerto pendente. Realize o acerto financeiro primeiro.');
  }

  await run("DELETE FROM motoboys WHERE id = ?", [id]);
}

async function getExtratoMotoboy(id) {
  // Pacotes finalizados vinculados ao motoboy
  const pacotes = await all(
    `SELECT p.id AS pacote_id, p.finalizado_em, p.coletado_em
     FROM pacotes p WHERE p.motoboy_id = ? AND p.status = 'finalizado'
     ORDER BY p.finalizado_em DESC LIMIT 100`,
    [id]
  );
  const rows = [];
  for (const pac of pacotes) {
    const peds = await all(
      `SELECT codigo, cliente_nome, bairro, total, taxa_entrega, finalizado_em FROM pedidos
       WHERE pacote_id = ? ORDER BY criado_em`,
      [pac.pacote_id]
    );
    for (const p of peds) rows.push({ ...p, pacote_id: pac.pacote_id });
  }
  return rows;
}

async function zerarAcertoMotoboy(id) {
  const m = await get('SELECT saldo_acerto FROM motoboys WHERE id = ?', [id]);
  const total = +(m?.saldo_acerto) || 0;
  await run(`UPDATE motoboys SET saldo_acerto = 0, pagamento_pendente = 0 WHERE id = ?`, [id]);
  if (total > 0) {
    await run(
      `INSERT INTO historico_motoboys (motoboy_id, tipo, valor, descricao) VALUES (?, 'ACERTO', ?, ?)`,
      [id, total, `Acerto registrado: R$ ${total.toFixed(2)}`]
    );
  }
}

async function getHistoricoMotoboy(id) {
  return all(
    `SELECT pe.codigo, pe.cliente_nome, pe.bairro, pe.total, pe.taxa_entrega,
            pe.finalizado_em, pac.motoboy_id
     FROM pedidos pe
     INNER JOIN pacotes pac ON pac.id = pe.pacote_id
     WHERE pac.motoboy_id = ?
     ORDER BY pe.finalizado_em DESC NULLS LAST, pe.criado_em DESC
     LIMIT 200`,
    [id]
  );
}

async function gerarTokenConvite() {
  // Delegado para criarTokenCadastro() — usa tokens_cadastro (Fase Bot-1)
  return criarTokenCadastro();
}

// ─── Bot Telegram — Funções de suporte (Fase Bot-1) ──────────────────────────
//
// INVARIANTE DE STATUS:
//   'status' (TEXT) = administrativo: 'ativo' | 'inativo' — mexido APENAS pela UI do operador.
//   'operacional_status' (TEXT) = operacional: 'ONLINE'|'OFFLINE'|'EM_ROTA'|'EM_ENTREGA' —
//   SÓ deve ser escrito via setStatusOperacional(). Nunca escrever operacional_status direto.

/**
 * Único ponto autorizado a escrever em operacional_status.
 * Nunca toca na coluna 'status' administrativa.
 */
async function setStatusOperacional(telegram_id, estado) {
  await run(
    `UPDATE motoboys SET operacional_status = ?, ultima_atualizacao = datetime('now')
     WHERE telegram_id = ?`,
    [estado, telegram_id]
  );
}

async function getMotoboyByTelegramId(telegram_id) {
  return get('SELECT * FROM motoboys WHERE telegram_id = ?', [telegram_id]);
}

/**
 * Cria ou atualiza motoboy por telegram_id.
 * Não toca na coluna 'status' administrativa — motoboys novos entram como 'ativo'.
 * Valores de estado operacional (ONLINE/OFFLINE/EM_ROTA/EM_ENTREGA) são roteados via setStatusOperacional.
 */
async function upsertMotoboyByTelegramId(dados) {
  const { telegram_id } = dados;
  if (!telegram_id) return null;

  // INSERT OR IGNORE garante que a row existe sem sobrescrever se já houver
  await run(
    `INSERT OR IGNORE INTO motoboys (telegram_id, nome, status, operacional_status)
     VALUES (?, ?, 'ativo', 'OFFLINE')`,
    [telegram_id, dados.nome || 'Parceiro']
  );

  // Atualiza campos e status operacional
  await atualizarCamposMotoboyByTelegramId(telegram_id, dados);

  return getMotoboyByTelegramId(telegram_id);
}

/**
 * Atualiza campos arbitrários de um motoboy por telegram_id.
 * Allowlist explícita — nunca expõe 'status' administrativo ao bot.
 * Roteia 'status' ou 'operacional_status' operacionais para setStatusOperacional.
 */
async function atualizarCamposMotoboyByTelegramId(telegram_id, campos) {
  const allowed = ['nome','whatsapp','cpf','vinculo','veiculo','pix',
                   'lat','lng','pendente_desde','pagamento_pendente',
                   'no_nome','no_url','taxa_deslocamento','distancia_km'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (campos[k] !== undefined) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (sets.length) {
    vals.push(telegram_id);
    await run(
      `UPDATE motoboys SET ${sets.join(', ')}, ultima_atualizacao = datetime('now')
       WHERE telegram_id = ?`,
      vals
    );
  }
  // Roteia status operacional — aceita tanto 'operacional_status' quanto 'status' do bot antigo
  const estadoOp = campos.operacional_status || campos.status;
  if (estadoOp && ['ONLINE','OFFLINE','EM_ROTA','EM_ENTREGA'].includes(estadoOp)) {
    await setStatusOperacional(telegram_id, estadoOp);
  }
}

/**
 * Remove motoboy por telegram_id. Preserva histórico de entregas (NULL motoboy_id).
 */
async function deletarMotoboyByTelegramId(telegram_id) {
  const m = await getMotoboyByTelegramId(telegram_id);
  if (!m) return;
  await run('UPDATE entregas SET motoboy_id = NULL WHERE motoboy_id = ?', [m.id]);
  await run('DELETE FROM motoboys WHERE telegram_id = ?', [telegram_id]);
}

async function validarEUsarToken(token) {
  const row = await get(
    'SELECT * FROM tokens_cadastro WHERE token = ? AND usado = 0',
    [token]
  );
  if (!row) return false;
  await run('UPDATE tokens_cadastro SET usado = 1 WHERE token = ?', [token]);
  return true;
}

async function criarTokenCadastro() {
  const crypto = require('crypto');
  const token = crypto.randomBytes(16).toString('hex');
  await run('INSERT INTO tokens_cadastro (token) VALUES (?)', [token]);
  return token;
}

/**
 * Gera e persiste um código de 4 dígitos único por pedido.
 * Chamado no createPedido — cada pedido nasce com seu próprio código.
 * Unicidade verificada contra pedidos ATIVOS (não finalizados/cancelados/estornados).
 */
async function gerarCodigoEntrega(pedido_id) {
  for (let t = 0; t < 20; t++) {
    const codigo = String(Math.floor(1000 + Math.random() * 9000));
    const conflito = await get(
      `SELECT id FROM pedidos WHERE codigo_entrega = ?
       AND status NOT IN ('finalizado','cancelado','estornado')
       AND id != ?`,
      [codigo, pedido_id]
    );
    if (!conflito) {
      await run('UPDATE pedidos SET codigo_entrega = ? WHERE id = ?', [codigo, pedido_id]);
      return codigo;
    }
  }
  throw new Error('Não foi possível gerar código de entrega único após 20 tentativas');
}

/**
 * Registra uma entrega no extrato financeiro.
 * Local: motoboy_id + motoboy_telegram_id, origem='local'.
 * Nuvem: motoboy_id=NULL, motoboy_telegram_id + no_origem, origem='nuvem'.
 */
async function registrarEntrega({ motoboy_id, motoboy_telegram_id, origem, no_origem, pedido_id, valor_entrega, taxa_deslocamento }) {
  const { lastID } = await run(
    `INSERT INTO entregas
       (motoboy_id, motoboy_telegram_id, origem, no_origem, pedido_id, valor_entrega, taxa_deslocamento)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [motoboy_id || null, motoboy_telegram_id || null,
     origem || 'local', no_origem || null, pedido_id || null,
     valor_entrega || 0, taxa_deslocamento || 0]
  );
  return get('SELECT * FROM entregas WHERE id = ?', [lastID]);
}

/**
 * Retorna entregas PENDENTE de um motoboy (por telegram_id).
 * Funciona tanto para locais (join por motoboy_id) quanto para Nuvem (só telegram_id).
 */
async function getExtratoMotoboyByTelegramId(telegram_id) {
  const m = await getMotoboyByTelegramId(telegram_id);
  if (m) {
    return all(
      `SELECT e.*, p.codigo AS pedido_codigo, p.cliente_nome, p.bairro
       FROM entregas e
       LEFT JOIN pedidos p ON p.id = e.pedido_id
       WHERE (e.motoboy_id = ? OR e.motoboy_telegram_id = ?) AND e.status = 'PENDENTE'
       ORDER BY e.data DESC`,
      [m.id, telegram_id]
    );
  }
  return all(
    `SELECT e.*, p.codigo AS pedido_codigo, p.cliente_nome, p.bairro
     FROM entregas e
     LEFT JOIN pedidos p ON p.id = e.pedido_id
     WHERE e.motoboy_telegram_id = ? AND e.status = 'PENDENTE'
     ORDER BY e.data DESC`,
    [telegram_id]
  );
}

async function zerarAcertoMotoboyByTelegramId(telegram_id) {
  const m = await getMotoboyByTelegramId(telegram_id);
  if (m) {
    const totRow = await get(
      `SELECT COALESCE(SUM(valor_entrega + taxa_deslocamento), 0) AS total FROM entregas
       WHERE status = 'PENDENTE' AND (motoboy_telegram_id = ? OR motoboy_id = ?)`,
      [telegram_id, m.id]
    );
    const total = +(totRow?.total) || 0;
    await run(
      `UPDATE entregas SET status = 'PAGO'
       WHERE status = 'PENDENTE' AND (motoboy_telegram_id = ? OR motoboy_id = ?)`,
      [telegram_id, m.id]
    );
    await run(
      'UPDATE motoboys SET saldo_acerto = 0, pagamento_pendente = 0 WHERE id = ?',
      [m.id]
    );
    if (total > 0) {
      await run(
        `INSERT INTO historico_motoboys (motoboy_id, tipo, valor, descricao) VALUES (?, 'ACERTO', ?, ?)`,
        [m.id, total, `Acerto registrado: R$ ${total.toFixed(2)}`]
      );
    }
  } else {
    // Motoboy sem registro local — só marca PAGO na tabela entregas
    await run(
      `UPDATE entregas SET status = 'PAGO'
       WHERE status = 'PENDENTE' AND motoboy_telegram_id = ?`,
      [telegram_id]
    );
  }
}

/**
 * Retorna pedidos em_rota de um motoboy identificado por telegram_id.
 * Busca via JOIN pacotes → motoboys.
 */
async function getRotasMotoboyByTelegramId(telegram_id) {
  return all(
    `SELECT pe.*, pac.id AS pacote_id, pac.status AS pacote_status
     FROM pedidos pe
     INNER JOIN pacotes pac ON pac.id = pe.pacote_id
     INNER JOIN motoboys m ON m.id = pac.motoboy_id
     WHERE m.telegram_id = ? AND pe.status = 'em_rota'
     ORDER BY pe.criado_em`,
    [telegram_id]
  );
}

/**
 * Marca OFFLINE todos os motoboys ONLINE/EM_ROTA que não enviaram GPS nos últimos 5 minutos.
 * Retorna o número de motoboys derrubados.
 */
async function limparRadarInativo() {
  const result = await run(
    `UPDATE motoboys
     SET operacional_status = 'OFFLINE', ultima_atualizacao = datetime('now')
     WHERE operacional_status IN ('ONLINE','EM_ROTA','EM_ENTREGA')
       AND ultima_atualizacao < datetime('now', '-5 minutes')`,
    []
  );
  return result.changes || 0;
}

// ─── Bot-4: sessões de chat (SOS / Falar com cliente) ────────────────────────

async function criarChatSessao({ telegram_id, tipo, telefone_cliente = null, nome_cliente = null, pedido_id = null }) {
  await run('DELETE FROM chat_sessoes WHERE telegram_id = ?', [telegram_id]);
  await run(
    `INSERT INTO chat_sessoes (telegram_id, tipo, telefone_cliente, nome_cliente, pedido_id)
     VALUES (?, ?, ?, ?, ?)`,
    [telegram_id, tipo, telefone_cliente, nome_cliente, pedido_id]
  );
}

async function getChatSessaoPorTelegramId(telegram_id) {
  return get('SELECT * FROM chat_sessoes WHERE telegram_id = ?', [telegram_id]);
}

async function getChatSessaoPorTelefone(telefone_cliente) {
  return get('SELECT * FROM chat_sessoes WHERE telefone_cliente = ?', [telefone_cliente]);
}

async function encerrarChatSessao(telegram_id) {
  await run('DELETE FROM chat_sessoes WHERE telegram_id = ?', [telegram_id]);
}

// ─── Pacotes ──────────────────────────────────────────────────────────────────
async function getPacotesAtivos() {
  const pacotes = await all(`
    SELECT p.*, m.nome AS motoboy_nome, m.vinculo AS motoboy_vinculo
    FROM pacotes p
    LEFT JOIN motoboys m ON m.id = p.motoboy_id
    WHERE p.status IN ('montando','aguardando','aguardando_coleta','em_rota')
    ORDER BY p.criado_em DESC
  `);
  for (const pac of pacotes) {
    pac.pedidos = await all(
      "SELECT * FROM pedidos WHERE pacote_id = ? AND status != 'entregue' ORDER BY criado_em",
      [pac.id]
    );
  }
  return pacotes;
}
async function createPacote() {
  const { lastID } = await run("INSERT INTO pacotes (status) VALUES ('montando')");
  return get("SELECT * FROM pacotes WHERE id = ?", [lastID]);
}
async function patchPacote(id, fields) {
  const allowed = ['status','motoboy_id','despachado_em','coletado_em','finalizado_em'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE pacotes SET ${sets.join(',')} WHERE id=?`, vals);
}
/**
 * Transição atômica de status: atualiza pacote E pedidos do pacote numa única transação
 * SQLite (BEGIN → UPDATE pacotes → UPDATE pedidos → COMMIT; ROLLBACK em erro).
 *
 * Garante que o estado do pacote e dos pedidos vinculados nunca fique inconsistente:
 * ou ambos são atualizados, ou nenhum é (rollback total).
 *
 * @param {number} pacoteId
 * @param {Object} patchPacote  - campos a setar na tabela `pacotes`
 *                                (allowlist: status, motoboy_id, despachado_em, coletado_em, finalizado_em)
 * @param {Object} patchPedidos - campos a setar na tabela `pedidos`
 *                                (allowlist: status, finalizado_em)
 * @param {string} [pedidosWhereExtra=''] - cláusula WHERE extra para filtrar pedidos além de
 *                                          `pacote_id=?` (ex: "AND status='em_rota'").
 *                                          Deve vir sempre de código interno — nunca de input externo.
 * @throws {Error} se a transação falhar (já fez ROLLBACK antes de lançar)
 */
async function moverPacoteComPedidos(pacoteId, patchPacote, patchPedidos, pedidosWhereExtra = '') {
  const allowedPacote  = ['status', 'motoboy_id', 'despachado_em', 'coletado_em', 'finalizado_em'];
  const allowedPedidos = ['status', 'finalizado_em'];

  const pacoteSets = [], pacoteVals = [];
  for (const [k, v] of Object.entries(patchPacote)) {
    if (allowedPacote.includes(k)) { pacoteSets.push(`${k}=?`); pacoteVals.push(v); }
  }
  if (!pacoteSets.length) throw new Error('moverPacoteComPedidos: nenhum campo válido para pacotes');

  const pedidosSets = [], pedidosVals = [];
  for (const [k, v] of Object.entries(patchPedidos)) {
    if (allowedPedidos.includes(k)) { pedidosSets.push(`${k}=?`); pedidosVals.push(v); }
  }
  if (!pedidosSets.length) throw new Error('moverPacoteComPedidos: nenhum campo válido para pedidos');

  await run('BEGIN');
  try {
    await run(
      `UPDATE pacotes SET ${pacoteSets.join(',')} WHERE id=?`,
      [...pacoteVals, pacoteId]
    );
    await run(
      `UPDATE pedidos SET ${pedidosSets.join(',')} WHERE pacote_id=? ${pedidosWhereExtra}`,
      [...pedidosVals, pacoteId]
    );
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(rbErr => console.error('[DB] falha no ROLLBACK após erro de transação:', rbErr.message));
    throw err; // propaga para o chamador decidir o feedback ao usuário
  }
}

async function deletePacote(id) {
  await run("UPDATE pedidos SET pacote_id=NULL, status='preparacao' WHERE pacote_id=?", [id]);
  await run("DELETE FROM pacotes WHERE id=?", [id]);
}

// ─── Pedidos ──────────────────────────────────────────────────────────────────
function gerarCodigo() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}
async function getPedidos({ status, origem, data_de, data_ate, busca, limit = 50, offset = 0 } = {}) {
  const conds = [], vals = [];
  if (status && status !== 'todos') { conds.push('p.status=?'); vals.push(status); }
  if (origem && origem !== 'todos') { conds.push('p.origem=?'); vals.push(origem); }
  if (data_de) { conds.push("date(p.criado_em)>=date(?)"); vals.push(data_de); }
  if (data_ate) { conds.push("date(p.criado_em)<=date(?)"); vals.push(data_ate); }
  if (busca) { conds.push("(p.codigo LIKE ? OR p.cliente_nome LIKE ? OR p.cliente_whatsapp LIKE ?)"); vals.push(`%${busca}%`,`%${busca}%`,`%${busca}%`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = await all(
    `SELECT p.*, m.nome AS motoboy_nome FROM pedidos p
     LEFT JOIN motoboys m ON m.id = p.motoboy_id
     ${where} ORDER BY p.criado_em DESC LIMIT ? OFFSET ?`,
    [...vals, limit, offset]
  );
  const total = (await get(
    `SELECT COUNT(*) AS n FROM pedidos p ${where}`, vals
  ))?.n || 0;
  return { rows, total };
}
async function getPedidosKanban() {
  return all(`SELECT * FROM pedidos WHERE status IN ('preparacao','aguardando_pagamento') AND pacote_id IS NULL ORDER BY criado_em DESC`);
}
async function getPedidoByCodigo(codigo) {
  return get('SELECT * FROM pedidos WHERE codigo = ?', [codigo]);
}
async function createPedido(data) {
  let codigo = gerarCodigo();
  for (let i = 0; i < 5; i++) {
    const exists = await get("SELECT 1 FROM pedidos WHERE codigo=?", [codigo]);
    if (!exists) break;
    codigo = gerarCodigo();
  }
  const { lastID } = await run(
    `INSERT INTO pedidos (codigo,cliente_nome,cliente_whatsapp,endereco,endereco_formatado,bairro,complemento,
      itens,subtotal,taxa_entrega,total,forma_pagamento,origem,status,asaas_payment_id,lat,lng,observacoes,
      promocao_id,desconto_aplicado,troco_para,bandeira_cartao)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [codigo, data.cliente_nome||'', data.cliente_whatsapp||null, data.endereco||'',
     data.endereco_formatado||null,
     data.bairro||null, data.complemento||null, JSON.stringify(data.itens||[]),
     data.subtotal||0, data.taxa_entrega||0, data.total||0, data.forma_pagamento||null,
     data.origem||'manual', data.status||'preparacao', data.asaas_payment_id||null,
     data.lat||null, data.lng||null, data.observacoes||null,
     data.promocao_id||null, data.desconto_aplicado||0,
     data.troco_para != null ? +data.troco_para : null,
     data.bandeira_cartao||null]
  );
  // Cada pedido nasce com seu próprio código de entrega (4 dígitos único entre ativos)
  await gerarCodigoEntrega(lastID);
  return get("SELECT * FROM pedidos WHERE id=?", [lastID]);
}
async function patchPedido(id, fields) {
  const allowed = ['status','pacote_id','motoboy_id','finalizado_em','cliente_nome',
    'cliente_whatsapp','endereco','endereco_formatado','bairro','complemento','itens','subtotal',
    'taxa_entrega','total','forma_pagamento','lat','lng','codigo_entrega','observacoes',
    'troco_para','bandeira_cartao','avaliacao_entrega'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      sets.push(`${k}=?`);
      vals.push(k === 'itens' && typeof v !== 'string' ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE pedidos SET ${sets.join(',')} WHERE id=?`, vals);
}
async function deletePedido(id) {
  await run("DELETE FROM pedidos WHERE id=?", [id]);
}

// ─── Conversas WhatsApp (WA-2a) ───────────────────────────────────────────────
async function getConversaWA(numero) {
  return get('SELECT * FROM conversas_wa WHERE numero = ?', [numero]);
}

async function upsertConversaWA(numero, fields) {
  const row = await get('SELECT numero FROM conversas_wa WHERE numero = ?', [numero]);
  if (row) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
    vals.push(numero);
    await run(`UPDATE conversas_wa SET ${sets.join(', ')}, ultima_interacao = CURRENT_TIMESTAMP WHERE numero = ?`, vals);
  } else {
    const cols = ['numero', ...Object.keys(fields)];
    const phs  = cols.map(() => '?');
    const vals = [numero, ...Object.values(fields).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v)];
    await run(`INSERT INTO conversas_wa (${cols.join(', ')}) VALUES (${phs.join(', ')})`, vals);
  }
}

async function getProdutosParaAgente() {
  const prods = await all(
    `SELECT p.id, p.nome, p.preco, p.preco_promocional, p.descricao, p.esgotado,
            p.tem_variacoes, p.adicionais_grupos,
            c.nome AS categoria
     FROM produtos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.ativo = 1 AND (c.oculto IS NULL OR c.oculto = 0)
           AND (c.ativo IS NULL OR c.ativo = 1)
     ORDER BY c.nome, p.nome`
  );
  const vars = await all(
    `SELECT v.produto_id, v.nome, v.preco FROM variacoes v
     INNER JOIN produtos p ON p.id = v.produto_id AND p.ativo = 1
     ORDER BY v.ordem, v.id`
  );
  const adicionaisRaw = await all(
    `SELECT a.id, a.nome, ao.nome AS opcao_nome, ao.preco AS opcao_preco
     FROM adicionais a
     LEFT JOIN adicionais_opcoes ao ON ao.adicional_id = a.id
     ORDER BY a.id, ao.id`
  );

  const varMap = {};
  for (const v of vars) {
    if (!varMap[v.produto_id]) varMap[v.produto_id] = [];
    varMap[v.produto_id].push({ nome: v.nome, preco: v.preco });
  }

  const adicMap = {}; // id → { id, nome, opcoes[] }
  for (const a of adicionaisRaw) {
    if (!adicMap[a.id]) adicMap[a.id] = { id: a.id, nome: a.nome, opcoes: [] };
    if (a.opcao_nome) adicMap[a.id].opcoes.push({ nome: a.opcao_nome, preco: a.opcao_preco || 0 });
  }

  return prods.map(p => {
    const gruposIds = (() => { try { return JSON.parse(p.adicionais_grupos || '[]'); } catch (_) { return []; } })();
    return {
      id:            p.id,
      nome:          p.nome,
      categoria:     p.categoria || 'Sem categoria',
      preco:         p.preco,
      preco_promo:   p.preco_promocional || null,
      descricao:     p.descricao || '',
      esgotado:      p.esgotado === 1,
      tem_variacoes: p.tem_variacoes === 1,
      variacoes:     varMap[p.id] || [],
      adicionais:    gruposIds.map(id => adicMap[id]).filter(Boolean),
    };
  });
}

// ─── Clientes recorrentes WhatsApp (WA-2c) ───────────────────────────────────
async function getClienteWA(numero) {
  return get('SELECT * FROM clientes_wa WHERE numero = ?', [numero]);
}

async function upsertClienteWA(numero, fields) {
  const allowed = ['nome', 'ultimo_endereco', 'ultimo_lat', 'ultimo_lng', 'ultima_zona'];
  const row = await get('SELECT numero, total_pedidos FROM clientes_wa WHERE numero = ?', [numero]);

  if (row) {
    const sets = [`atualizado_em = datetime('now')`];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined && fields[k] !== null) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (fields.incrementar_pedido) { sets.push('total_pedidos = total_pedidos + 1'); }
    vals.push(numero);
    await run(`UPDATE clientes_wa SET ${sets.join(', ')} WHERE numero = ?`, vals);
  } else {
    const cols = ['numero', 'atualizado_em'];
    const phs  = ['?', "datetime('now')"];
    const vals = [numero];
    for (const k of allowed) {
      if (fields[k] !== undefined && fields[k] !== null) { cols.push(k); phs.push('?'); vals.push(fields[k]); }
    }
    if (fields.incrementar_pedido) { cols.push('total_pedidos'); phs.push('1'); }
    await run(`INSERT INTO clientes_wa (${cols.join(', ')}) VALUES (${phs.join(', ')})`, vals);
  }
}

// ─── Marketing Fase 2 — CRUD de promoções e cupons ───────────────────────────

function _parsePromocao(row) {
  if (!row) return row;
  const JSON_FIELDS = ['formas_pagamento', 'zonas_excluidas', 'dias_semana'];
  const out = { ...row };
  for (const f of JSON_FIELDS) {
    out[f] = out[f] ? JSON.parse(out[f]) : null;
  }
  return out;
}

async function getPromocoes(tipo) {
  const rows = tipo
    ? await all('SELECT * FROM promocoes WHERE tipo = ? ORDER BY criado_em DESC', [tipo])
    : await all('SELECT * FROM promocoes ORDER BY criado_em DESC');
  return rows.map(_parsePromocao);
}

async function createPromocao(data) {
  const J = (v) => (Array.isArray(v) && v.length ? JSON.stringify(v) : null);
  const { lastID } = await run(
    `INSERT INTO promocoes
       (tipo, nome, codigo, descricao, beneficio_tipo, beneficio_valor,
        min_pedidos, dias_sem_pedir, min_total_gasto, min_ticket_medio,
        formas_pagamento, zonas_excluidas, valor_minimo_pedido,
        dias_semana, hora_inicio, hora_fim, ativa, visibilidade, imagem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.tipo, data.nome, data.codigo || null, data.descricao || null,
      data.beneficio_tipo, data.beneficio_valor != null ? Number(data.beneficio_valor) : null,
      data.min_pedidos      != null ? Number(data.min_pedidos)      : null,
      data.dias_sem_pedir   != null ? Number(data.dias_sem_pedir)   : null,
      data.min_total_gasto  != null ? Number(data.min_total_gasto)  : null,
      data.min_ticket_medio != null ? Number(data.min_ticket_medio) : null,
      J(data.formas_pagamento), J(data.zonas_excluidas),
      data.valor_minimo_pedido != null ? Number(data.valor_minimo_pedido) : null,
      J(data.dias_semana), data.hora_inicio || null, data.hora_fim || null,
      data.ativa !== undefined ? (data.ativa ? 1 : 0) : 1,
      data.visibilidade || 'segmentada',
      data.imagem || null,
    ]
  );
  return _parsePromocao(await get('SELECT * FROM promocoes WHERE id = ?', [lastID]));
}

async function updatePromocao(id, data) {
  const ALLOWED    = ['nome','codigo','descricao','beneficio_tipo','beneficio_valor',
    'min_pedidos','dias_sem_pedir','min_total_gasto','min_ticket_medio',
    'formas_pagamento','zonas_excluidas','valor_minimo_pedido',
    'dias_semana','hora_inicio','hora_fim','ativa','visibilidade','imagem'];
  const JSON_COLS  = new Set(['formas_pagamento','zonas_excluidas','dias_semana']);
  const sets = [], vals = [];
  for (const f of ALLOWED) {
    if (!(f in data)) continue;
    sets.push(`${f} = ?`);
    if (JSON_COLS.has(f)) {
      vals.push(Array.isArray(data[f]) && data[f].length ? JSON.stringify(data[f]) : null);
    } else if (f === 'ativa') {
      vals.push(data[f] ? 1 : 0);
    } else {
      vals.push(data[f] !== '' && data[f] != null ? data[f] : null);
    }
  }
  if (!sets.length) return _parsePromocao(await get('SELECT * FROM promocoes WHERE id = ?', [id]));
  vals.push(id);
  await run(`UPDATE promocoes SET ${sets.join(', ')} WHERE id = ?`, vals);
  return _parsePromocao(await get('SELECT * FROM promocoes WHERE id = ?', [id]));
}

async function deletePromocao(id) {
  await run('DELETE FROM promocoes WHERE id = ?', [id]);
}

async function getPromocoesPublicas() {
  const rows = await all(
    `SELECT * FROM promocoes WHERE visibilidade = 'publica' AND ativa = 1 ORDER BY criado_em DESC`
  );
  return rows.map(_parsePromocao);
}

async function getPromocaoPorId(id) {
  return _parsePromocao(await get('SELECT * FROM promocoes WHERE id = ?', [id]));
}

async function getCupomAtivo(codigo) {
  const row = await get(
    `SELECT * FROM promocoes WHERE tipo = 'cupom' AND ativa = 1 AND LOWER(codigo) = LOWER(?)`,
    [codigo]
  );
  return _parsePromocao(row);
}

/**
 * Retorna promoções segmentadas ativas para as quais o cliente é elegível.
 * Aplica apenas critérios de cliente (min_pedidos, dias_sem_pedir, min_total_gasto,
 * min_ticket_medio, formas_pagamento, zonas_excluidas).
 * Janela de horário e zona de entrega do pedido atual são verificadas no agente.
 */
async function getPromocoesElegiveisCliente(numero) {
  // Busca pelo sufixo dos últimos 8 dígitos para tolerar variações do 9º dígito
  // e diferenças de DDI (+55). Reusa o mesmo princípio de _tail8() de index.js.
  // Se houver mais de uma linha (improvável), prefere match exato; senão, pega o primeiro.
  const tail8 = String(numero || '').replace(/\D/g, '').slice(-8);
  const candidatos = await all(
    `SELECT total_pedidos, total_gasto, ticket_medio, ultimo_pedido_em,
            forma_pagamento_frequente, zona_frequente, numero
     FROM clientes_wa WHERE SUBSTR(numero, -8) = ?`,
    [tail8]
  );
  const cliente = candidatos.find(c => c.numero === numero) || candidatos[0] || null;
  const clienteNumero = cliente?.numero || numero;
  console.log(`[PROMO] lookup cliente numero=${numero} tail8=${tail8} → ${cliente ? `encontrado(${clienteNumero})` : 'não encontrado'}`);
  // Remove campo auxiliar antes de usar stats
  if (cliente) delete cliente.numero;

  const promos = await all(
    `SELECT * FROM promocoes WHERE tipo = 'promocao' AND visibilidade = 'segmentada' AND ativa = 1`,
    []
  );

  return promos.map(_parsePromocao).filter(p => {
    if (p.min_pedidos != null && (!cliente || (cliente.total_pedidos || 0) < p.min_pedidos)) {
      console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: min_pedidos=${p.min_pedidos} cliente=${cliente?.total_pedidos ?? 'null'}`);
      return false;
    }
    if (p.dias_sem_pedir != null) {
      if (!cliente?.ultimo_pedido_em) {
        console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: sem historico (dias_sem_pedir=${p.dias_sem_pedir})`);
        return false;
      }
      const diasSince = (Date.now() - new Date(cliente.ultimo_pedido_em).getTime()) / 86400000;
      if (diasSince < p.dias_sem_pedir) {
        console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: dias_sem_pedir=${p.dias_sem_pedir} atual=${diasSince.toFixed(1)}`);
        return false;
      }
    }
    if (p.min_total_gasto != null && (!cliente || (cliente.total_gasto || 0) < p.min_total_gasto)) {
      console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: min_total_gasto=${p.min_total_gasto} cliente=${cliente?.total_gasto ?? 'null'}`);
      return false;
    }
    if (p.min_ticket_medio != null && (!cliente || (cliente.ticket_medio || 0) < p.min_ticket_medio)) {
      console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: min_ticket_medio=${p.min_ticket_medio} cliente=${cliente?.ticket_medio ?? 'null'}`);
      return false;
    }
    if (Array.isArray(p.formas_pagamento) && p.formas_pagamento.length > 0) {
      if (!cliente?.forma_pagamento_frequente || !p.formas_pagamento.includes(cliente.forma_pagamento_frequente)) {
        console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: forma_pagamento cliente=${cliente?.forma_pagamento_frequente ?? 'null'} elegíveis=${JSON.stringify(p.formas_pagamento)}`);
        return false;
      }
    }
    if (Array.isArray(p.zonas_excluidas) && p.zonas_excluidas.length > 0) {
      if (cliente?.zona_frequente && p.zonas_excluidas.includes(cliente.zona_frequente)) {
        console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → rejeitado: zona=${cliente.zona_frequente} excluída`);
        return false;
      }
    }
    console.log(`[PROMO] segmentada '${p.nome}' cliente=${numero} → match=true`);
    return true;
  });
}

// ─── Marketing Fase 1 — histórico agregado de clientes ───────────────────────

/**
 * Recalcula do zero os agregados de um cliente a partir dos pedidos reais.
 * Chamado automaticamente após fechar_pedido e disponível para backfill.
 */
async function recalcularHistoricoCliente(numero) {
  // Agrega totais e último pedido
  const agg = await get(
    `SELECT
       COUNT(*)                 AS total_pedidos,
       COALESCE(SUM(total), 0)  AS total_gasto,
       MAX(criado_em)           AS ultimo_pedido_em
     FROM pedidos
     WHERE cliente_whatsapp = ?`,
    [numero]
  );
  if (!agg || agg.total_pedidos === 0) return; // nada a registrar

  // Forma de pagamento mais frequente
  const fpRow = await get(
    `SELECT forma_pagamento, COUNT(*) AS cnt
     FROM pedidos
     WHERE cliente_whatsapp = ? AND forma_pagamento IS NOT NULL
     GROUP BY forma_pagamento
     ORDER BY cnt DESC
     LIMIT 1`,
    [numero]
  );

  // Zona (bairro) mais frequente
  const zonaRow = await get(
    `SELECT bairro, COUNT(*) AS cnt
     FROM pedidos
     WHERE cliente_whatsapp = ? AND bairro IS NOT NULL AND bairro != ''
     GROUP BY bairro
     ORDER BY cnt DESC
     LIMIT 1`,
    [numero]
  );

  const total_pedidos  = agg.total_pedidos;
  const total_gasto    = agg.total_gasto;
  const ticket_medio   = total_pedidos > 0 ? total_gasto / total_pedidos : 0;
  const ultimo_pedido_em              = agg.ultimo_pedido_em;
  const forma_pagamento_frequente     = fpRow?.forma_pagamento   || null;
  const zona_frequente                = zonaRow?.bairro          || null;

  const exists = await get('SELECT numero FROM clientes_wa WHERE numero = ?', [numero]);
  if (exists) {
    await run(
      `UPDATE clientes_wa SET
         total_pedidos = ?,
         total_gasto = ?,
         ticket_medio = ?,
         ultimo_pedido_em = ?,
         forma_pagamento_frequente = ?,
         zona_frequente = ?,
         atualizado_em = datetime('now')
       WHERE numero = ?`,
      [total_pedidos, total_gasto, ticket_medio, ultimo_pedido_em,
       forma_pagamento_frequente, zona_frequente, numero]
    );
  } else {
    await run(
      `INSERT INTO clientes_wa
         (numero, total_pedidos, total_gasto, ticket_medio, ultimo_pedido_em,
          forma_pagamento_frequente, zona_frequente, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [numero, total_pedidos, total_gasto, ticket_medio, ultimo_pedido_em,
       forma_pagamento_frequente, zona_frequente]
    );
  }
}

/**
 * Backfill: recalcula o histórico de TODOS os clientes que têm pedidos.
 * Retorna o número de clientes processados.
 */
async function recalcularTodosClientes() {
  const rows = await all(
    `SELECT DISTINCT cliente_whatsapp FROM pedidos
     WHERE cliente_whatsapp IS NOT NULL AND cliente_whatsapp != ''`
  );
  for (const { cliente_whatsapp } of rows) {
    try {
      await recalcularHistoricoCliente(cliente_whatsapp);
    } catch (e) {
      console.error(`[Marketing] recalcularHistoricoCliente(${cliente_whatsapp}) erro: ${e.message}`);
    }
  }
  console.log(`[Marketing] backfill concluído: ${rows.length} cliente(s) processado(s)`);
  return rows.length;
}

/**
 * Retorna clientes elegíveis de acordo com os critérios fornecidos.
 * Todos os critérios são opcionais; sem critérios = todos os clientes.
 *
 * @param {Object} criterios
 * @param {number}   [criterios.min_pedidos]        - mínimo de pedidos
 * @param {number}   [criterios.dias_sem_pedir]     - sem pedir há >= N dias
 * @param {number}   [criterios.min_total_gasto]    - gasto total mínimo (R$)
 * @param {number}   [criterios.min_ticket_medio]   - ticket médio mínimo (R$)
 * @param {string[]} [criterios.formas_pagamento]   - forma_pagamento_frequente deve estar nesta lista
 * @param {string[]} [criterios.zonas_excluidas]    - zona_frequente NÃO deve estar nesta lista
 * @returns {{ total: number, clientes: Array }}
 */
async function getClientesElegiveis(criterios = {}) {
  const conds = [];
  const vals  = [];

  if (criterios.min_pedidos != null) {
    conds.push('total_pedidos >= ?');
    vals.push(Number(criterios.min_pedidos));
  }

  if (criterios.dias_sem_pedir != null) {
    // Clientes cujo último pedido foi há >= N dias (ou que nunca pediram — excluídos aqui)
    conds.push("ultimo_pedido_em IS NOT NULL AND (julianday('now') - julianday(ultimo_pedido_em)) >= ?");
    vals.push(Number(criterios.dias_sem_pedir));
  }

  if (criterios.min_total_gasto != null) {
    conds.push('total_gasto >= ?');
    vals.push(Number(criterios.min_total_gasto));
  }

  if (criterios.min_ticket_medio != null) {
    conds.push('ticket_medio >= ?');
    vals.push(Number(criterios.min_ticket_medio));
  }

  if (Array.isArray(criterios.formas_pagamento) && criterios.formas_pagamento.length > 0) {
    const phs = criterios.formas_pagamento.map(() => '?').join(', ');
    conds.push(`forma_pagamento_frequente IN (${phs})`);
    vals.push(...criterios.formas_pagamento);
  }

  if (Array.isArray(criterios.zonas_excluidas) && criterios.zonas_excluidas.length > 0) {
    const phs = criterios.zonas_excluidas.map(() => '?').join(', ');
    conds.push(`(zona_frequente IS NULL OR zona_frequente NOT IN (${phs}))`);
    vals.push(...criterios.zonas_excluidas);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const clientes = await all(
    `SELECT numero, nome, total_pedidos, total_gasto, ticket_medio,
            ultimo_pedido_em, forma_pagamento_frequente, zona_frequente,
            ultimo_endereco
     FROM clientes_wa
     ${where}
     ORDER BY ultimo_pedido_em DESC`,
    vals
  );

  return { total: clientes.length, clientes };
}

// ─── Chamados de atendimento humano (WA-2b) ───────────────────────────────────
async function createChamado({ numero, nome_cliente, motivo }) {
  const { lastID } = await run(
    `INSERT INTO chamados (numero, nome_cliente, motivo) VALUES (?, ?, ?)`,
    [numero, nome_cliente || null, motivo || null]
  );
  return get('SELECT * FROM chamados WHERE id = ?', [lastID]);
}

async function getChamadosAbertos() {
  return all(
    `SELECT c.*, cwa.historico FROM chamados c
     LEFT JOIN conversas_wa cwa ON cwa.numero = c.numero
     WHERE c.status = 'aberto' ORDER BY c.criado_em DESC`
  );
}

async function getChamado(id) {
  return get(
    `SELECT c.*, cwa.historico FROM chamados c
     LEFT JOIN conversas_wa cwa ON cwa.numero = c.numero
     WHERE c.id = ?`,
    [id]
  );
}

async function patchChamado(id, fields) {
  const allowed = ['status', 'resolvido_em', 'nome_cliente', 'motivo'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE chamados SET ${sets.join(',')} WHERE id=?`, vals);
}

// ─── Estornos ─────────────────────────────────────────────────────────────────
async function getEstornos({ status, data_de, data_ate } = {}) {
  const conds = [], vals = [];
  if (status && status !== 'todos') { conds.push('e.status=?'); vals.push(status); }
  if (data_de) { conds.push("date(e.criado_em)>=date(?)"); vals.push(data_de); }
  if (data_ate) { conds.push("date(e.criado_em)<=date(?)"); vals.push(data_ate); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return all(
    `SELECT e.*, p.codigo, p.cliente_nome, p.total AS pedido_total
     FROM estornos e
     JOIN pedidos p ON p.id = e.pedido_id
     ${where} ORDER BY e.criado_em DESC LIMIT 200`,
    vals
  );
}
async function createEstorno(data) {
  const { lastID } = await run(
    "INSERT INTO estornos (pedido_id,valor,motivo,asaas_refund_id,status) VALUES (?,?,?,?,?)",
    [data.pedido_id, data.valor, data.motivo||null, data.asaas_refund_id||null, data.status||'pendente']
  );
  return get("SELECT * FROM estornos WHERE id=?", [lastID]);
}
async function patchEstorno(id, fields) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (['status','asaas_refund_id'].includes(k)) { sets.push(`${k}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE estornos SET ${sets.join(',')} WHERE id=?`, vals);
}

// ─── Pedido por código (modal Atendimentos) ──────────────────────────────────
async function getPedidoPorCodigo(codigo) {
  return get('SELECT * FROM pedidos WHERE codigo = ?', [codigo]);
}

// ─── Clientes Recentes (painel Atendimentos) ─────────────────────────────────

async function getClientesRecentes() {
  // CTE: agrupa por tail8, depois filtra ocultos em outer query (evita alias-in-HAVING
  // e misuse-of-aggregate em subquery do HAVING).
  return all(`
    WITH grupos AS (
      SELECT
        SUBSTR(p.cliente_whatsapp, -8)                                       AS tail8,
        MAX(p.cliente_whatsapp)                                              AS whatsapp,
        MAX(p.cliente_nome)                                                  AS nome,
        MAX(CASE WHEN p.endereco IS NOT NULL THEN p.endereco END)            AS ultimo_endereco,
        COUNT(*)                                                             AS total_pedidos,
        SUM(p.total)                                                         AS total_gasto,
        MAX(p.criado_em)                                                     AS ultimo_pedido_em
      FROM pedidos p
      WHERE p.cliente_whatsapp IS NOT NULL
      GROUP BY SUBSTR(p.cliente_whatsapp, -8)
    )
    SELECT g.whatsapp, g.nome, g.ultimo_endereco,
           g.total_pedidos, g.total_gasto, g.ultimo_pedido_em
    FROM grupos g
    LEFT JOIN clientes_ocultos co ON SUBSTR(co.whatsapp, -8) = g.tail8
    WHERE co.oculto_em IS NULL OR g.ultimo_pedido_em > co.oculto_em
    ORDER BY g.ultimo_pedido_em DESC
  `);
}

async function getDetalheClienteRecente(whatsapp) {
  const tail8 = String(whatsapp || '').replace(/\D/g, '').slice(-8);
  const info = await get(`
    SELECT
      MAX(p.cliente_whatsapp) AS whatsapp,
      MAX(p.cliente_nome)     AS nome,
      MAX(CASE WHEN p.endereco IS NOT NULL THEN p.endereco END) AS ultimo_endereco,
      COUNT(*)                AS total_pedidos,
      SUM(p.total)            AS total_gasto,
      MAX(p.criado_em)        AS ultimo_pedido_em
    FROM pedidos p
    WHERE p.cliente_whatsapp IS NOT NULL
      AND SUBSTR(p.cliente_whatsapp, -8) = ?
  `, [tail8]);

  const pedidosList = await all(`
    SELECT id, codigo, criado_em, total, status, forma_pagamento, endereco, bairro, itens
    FROM pedidos
    WHERE cliente_whatsapp IS NOT NULL
      AND SUBSTR(cliente_whatsapp, -8) = ?
    ORDER BY criado_em DESC
    LIMIT 20
  `, [tail8]);

  // Aggregate sem GROUP BY sempre retorna uma linha, mesmo sem dados.
  // Usa total_pedidos=0 como sinal de "cliente não encontrado".
  if (!info || !info.total_pedidos) return { info: null, pedidos: [] };
  return { info, pedidos: pedidosList };
}

async function ocultarClienteRecente(whatsapp) {
  await run(
    `INSERT INTO clientes_ocultos (whatsapp, oculto_em) VALUES (?, datetime('now'))
     ON CONFLICT(whatsapp) DO UPDATE SET oculto_em = datetime('now')`,
    [whatsapp]
  );
}

// ─── Chat de atendimento humano (thread de mensagens) ────────────────────────

async function addMensagemWAChat(numero, de, texto) {
  return run(
    `INSERT INTO mensagens_wa_chat (numero, de, texto) VALUES (?, ?, ?)`,
    [numero, de, String(texto || '').slice(0, 4000)]
  );
}

async function getMensagensWAChat(numero, limit = 120) {
  return all(
    `SELECT id, numero, de, texto, criado_em
     FROM mensagens_wa_chat WHERE numero = ?
     ORDER BY criado_em ASC LIMIT ?`,
    [numero, limit]
  );
}

async function marcarMensagensLidas(numero) {
  return run(
    `UPDATE conversas_wa SET msgs_nao_lidas = 0 WHERE numero = ?`,
    [numero]
  );
}

async function incrementarMsgsNaoLidas(numero) {
  // garante que a linha existe antes de incrementar
  await upsertConversaWA(numero, {});
  return run(
    `UPDATE conversas_wa SET msgs_nao_lidas = COALESCE(msgs_nao_lidas, 0) + 1 WHERE numero = ?`,
    [numero]
  );
}

async function getAtendimentosPendentesCount() {
  const row = await get(
    `SELECT COUNT(*) AS cnt FROM conversas_wa WHERE modo_manual = 1 AND msgs_nao_lidas > 0`
  );
  return row?.cnt || 0;
}

async function contarPedidosCliente(whatsapp, criadoEm) {
  const tail8 = String(whatsapp || '').replace(/\D/g, '').slice(-8);
  const row = await get(`
    SELECT COUNT(*) AS cnt FROM pedidos
    WHERE cliente_whatsapp IS NOT NULL
      AND SUBSTR(cliente_whatsapp, -8) = ?
      AND criado_em <= ?
  `, [tail8, criadoEm]);
  return row?.cnt || 1;
}

// ─── Analytics / Relatórios ───────────────────────────────────────────────────

function _diasFiltro(dias, coluna) {
  if (!dias || String(dias) === '0') return '';
  const n = Math.abs(parseInt(dias, 10));
  if (!n) return '';
  return `AND date(${coluna}) >= date('now', '-${n} days')`;
}

async function analiticoHeatmap(dias) {
  return all(`
    SELECT
      CAST(strftime('%w', criado_em) AS INTEGER) AS dia,
      CAST(strftime('%H', criado_em) AS INTEGER) AS hora,
      COUNT(*) AS pedidos
    FROM pedidos
    WHERE status NOT IN ('cancelado')
    ${_diasFiltro(dias, 'criado_em')}
    GROUP BY dia, hora
    ORDER BY dia, hora
  `);
}

async function analiticoPedidosRaw(dias) {
  return all(`
    SELECT itens, bairro, total, subtotal, taxa_entrega, forma_pagamento,
           desconto_aplicado, promocao_id, criado_em, cliente_whatsapp
    FROM pedidos
    WHERE status NOT IN ('cancelado')
    ${_diasFiltro(dias, 'criado_em')}
    ORDER BY criado_em
  `);
}

async function analiticoProdutosAtivos() {
  return all(`
    SELECT p.id, p.nome, cat.nome AS categoria, p.preco
    FROM produtos p
    LEFT JOIN categorias cat ON cat.id = p.categoria_id
    WHERE p.ativo = 1
    ORDER BY cat.nome, p.nome
  `);
}

async function analiticoZonas(dias) {
  return all(`
    SELECT
      bairro,
      COUNT(*)              AS pedidos,
      ROUND(AVG(total), 2)  AS ticket_medio,
      ROUND(SUM(total), 2)  AS receita,
      ROUND(AVG(taxa_entrega), 2) AS taxa_media
    FROM pedidos
    WHERE status NOT IN ('cancelado')
      AND bairro IS NOT NULL AND bairro != ''
    ${_diasFiltro(dias, 'criado_em')}
    GROUP BY bairro
    ORDER BY receita DESC
    LIMIT 15
  `);
}

async function analiticoPagamentos(dias) {
  return all(`
    SELECT
      COALESCE(forma_pagamento, 'Não informado') AS forma,
      COUNT(*)              AS pedidos,
      ROUND(SUM(total), 2)  AS receita,
      ROUND(AVG(total), 2)  AS ticket_medio
    FROM pedidos
    WHERE status NOT IN ('cancelado')
    ${_diasFiltro(dias, 'criado_em')}
    GROUP BY forma_pagamento
    ORDER BY receita DESC
  `);
}

async function analiticoPromocoes(dias) {
  return all(`
    SELECT
      pr.nome,
      pr.beneficio_tipo,
      COUNT(p.id)                             AS pedidos,
      ROUND(SUM(p.desconto_aplicado), 2)      AS desconto_total,
      ROUND(SUM(p.total), 2)                  AS receita_liquida,
      ROUND(SUM(p.total + COALESCE(p.desconto_aplicado, 0)), 2) AS receita_bruta
    FROM pedidos p
    JOIN promocoes pr ON pr.id = p.promocao_id
    WHERE p.status NOT IN ('cancelado')
      AND p.promocao_id IS NOT NULL
    ${_diasFiltro(dias, 'p.criado_em')}
    GROUP BY p.promocao_id, pr.nome, pr.beneficio_tipo
    ORDER BY pedidos DESC
  `);
}

async function analiticoRecompra() {
  return all(`
    SELECT
      SUBSTR(cliente_whatsapp, -8) AS tail8,
      COUNT(*) AS total_pedidos,
      MIN(criado_em) AS primeiro_pedido,
      MAX(criado_em) AS ultimo_pedido
    FROM pedidos
    WHERE status NOT IN ('cancelado')
      AND cliente_whatsapp IS NOT NULL
    GROUP BY SUBSTR(cliente_whatsapp, -8)
  `);
}

// ─── Config ───────────────────────────────────────────────────────────────────
async function getAllConfig() {
  return all("SELECT key, value FROM config");
}

async function getConfig(key) {
  const row = await get("SELECT value FROM config WHERE key = ?", [key]);
  return row ? row.value : null;
}

async function setConfig(key, value) {
  await run(
    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
    [key, typeof value === "string" ? value : JSON.stringify(value)]
  );
  // horarios e formas_pagamento fazem parte do cardápio → sincroniza
  const cardapioKeys = ["horarios", "pedido_minimo", "formas_pagamento"];
  if (cardapioKeys.includes(key)) emitCardapioChanged();
}

/**
 * Retorna pedidos recentes (últimas 24h) do cliente pelo sufixo de 8 dígitos do whatsapp.
 * Cobre variações de 9º dígito e DDI (+55 vs 55 vs sem DDI).
 * Ordenado do mais recente para o mais antigo.
 */
async function getPedidosRecentesByNumero(numero) {
  const tail8 = String(numero || '').replace(/\D/g, '').slice(-8);
  return all(
    `SELECT codigo, status, codigo_entrega, criado_em, total, forma_pagamento, cliente_nome
     FROM pedidos
     WHERE SUBSTR(cliente_whatsapp, -8) = ?
       AND criado_em >= datetime('now', '-24 hours')
       AND status != 'cancelado'
     ORDER BY criado_em DESC`,
    [tail8]
  );
}

/**
 * Rastreamento completo: pedido + pacote + motoboy num único JOIN.
 * Retorna os pedidos ativos das últimas 24h com localização do motoboy quando em_rota.
 */
async function rastrearPedidoByNumero(numero) {
  const tail8 = String(numero || '').replace(/\D/g, '').slice(-8);
  return all(
    `SELECT
       pe.codigo,
       pe.status,
       pe.codigo_entrega,
       pe.lat        AS dest_lat,
       pe.lng        AS dest_lng,
       pe.endereco,
       pe.criado_em,
       pe.total,
       pa.id         AS pacote_id,
       pa.motoboy_id,
       pa.despachado_em,
       pa.coletado_em,
       mb.nome       AS motoboy_nome,
       mb.lat        AS mb_lat,
       mb.lng        AS mb_lng,
       mb.ultima_atualizacao AS mb_ultima_atualizacao,
       mb.operacional_status AS mb_status
     FROM pedidos pe
     LEFT JOIN pacotes  pa ON pe.pacote_id = pa.id
     LEFT JOIN motoboys mb ON pa.motoboy_id = mb.id
     WHERE SUBSTR(pe.cliente_whatsapp, -8) = ?
       AND pe.criado_em >= datetime('now', '-24 hours')
       AND pe.status != 'cancelado'
     ORDER BY pe.criado_em DESC`,
    [tail8]
  );
}

module.exports = {
  db,
  createOrder,
  // categorias
  getCategorias, saveCategoria, deleteCategoria, reorderCategorias,
  // produtos
  getProdutos, getProdutosTodos, saveProduto, deleteProduto,
  getProdutosByCategoria, patchProduto, reorderProdutos, duplicarProduto, moverProduto,
  // adicionais
  getAdicionais, saveAdicional, deleteAdicional,
  // variacoes
  getVariacoesByProduto, saveVariacao, deleteVariacao, reorderVariacoes,
  // bairros
  getBairros, saveBairro, deleteBairro,
  // zonas
  getZonas, saveZona, deleteZona, reorderZonas,
  // motoboys — UI
  getMotoboys, getMotoboysFleet, getMotoboy, saveMotoboy, deleteMotoboy,
  getExtratoMotoboy, zerarAcertoMotoboy, getHistoricoMotoboy, gerarTokenConvite,
  // motoboys — bot Telegram (Fase Bot-1)
  setStatusOperacional,
  getMotoboyByTelegramId, upsertMotoboyByTelegramId,
  atualizarCamposMotoboyByTelegramId, deletarMotoboyByTelegramId,
  validarEUsarToken, criarTokenCadastro,
  gerarCodigoEntrega, registrarEntrega,
  getExtratoMotoboyByTelegramId, zerarAcertoMotoboyByTelegramId,
  getRotasMotoboyByTelegramId, limparRadarInativo,
  // bot — Bot-4: SOS / chat com cliente
  criarChatSessao, getChatSessaoPorTelegramId, getChatSessaoPorTelefone, encerrarChatSessao,
  // pacotes
  getPacotesAtivos, createPacote, patchPacote, moverPacoteComPedidos, deletePacote,
  // pedidos
  getPedidos, getPedidosKanban, getPedidoByCodigo, createPedido, patchPedido, deletePedido,
  // estornos
  getEstornos, createEstorno, patchEstorno,
  // config
  getAllConfig, getConfig, setConfig,
  // whatsapp conversas (WA-2a)
  getConversaWA, upsertConversaWA, getProdutosParaAgente,
  // clientes recorrentes (WA-2c)
  getClienteWA, upsertClienteWA,
  // marketing fase 1 — histórico + elegibilidade
  recalcularHistoricoCliente, recalcularTodosClientes, getClientesElegiveis,
  // marketing fase 2 — CRUD promoções/cupons
  getPromocoes, createPromocao, updatePromocao, deletePromocao, getPromocoesPublicas,
  // marketing fase 3 — agente aplica descontos
  getPromocaoPorId, getCupomAtivo, getPromocoesElegiveisCliente,
  // chamados atendimento humano (WA-2b)
  createChamado, getChamadosAbertos, getChamado, patchChamado,
  // pedido por código — modal atendimentos
  getPedidoPorCodigo,
  // clientes recentes — painel atendimentos
  getClientesRecentes, getDetalheClienteRecente, ocultarClienteRecente, contarPedidosCliente,
  // chat thread de atendimento humano
  addMensagemWAChat, getMensagensWAChat, marcarMensagensLidas,
  incrementarMsgsNaoLidas, getAtendimentosPendentesCount,
  // status/rastreamento de pedido — tools da IA
  getPedidosRecentesByNumero,
  rastrearPedidoByNumero,
  // analytics / relatórios
  analiticoHeatmap, analiticoPedidosRaw, analiticoProdutosAtivos,
  analiticoZonas, analiticoPagamentos, analiticoPromocoes, analiticoRecompra,
};
