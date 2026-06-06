require("dotenv").config();

const path    = require("path");
const fs      = require("fs");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multer  = require("multer");
const { sendMessage } = require("./src/whatsapp/socket");
const { syncCardapio, sincronizarVitrine, getSyncStatus, vitrineFetch, startVitrineSync, agendarSyncVitrine } = require("./src/services/ceia-vitrine");
const { setConfig, getConfig, getChamadosAbertos, getChamado, patchChamado, upsertConversaWA,
        getClientesRecentes, getDetalheClienteRecente, ocultarClienteRecente,
        getPedidoPorCodigo, getConversaWA,
        addMensagemWAChat, getMensagensWAChat, marcarMensagensLidas, getAtendimentosPendentesCount,
        analiticoHeatmap, analiticoPedidosRaw, analiticoProdutosAtivos,
        analiticoZonas, analiticoPagamentos, analiticoPromocoes, analiticoRecompra } = require("./src/data/db");
const { ceiaEmitter } = require("./src/services/ceia-emitter");
const { iniciarTelegram, pararTelegram, getBotInfo, enviarRotaParaMotoboy, enviarMensagemBot, encerrarSessaoBot } = require("./src/bot/telegram");
const { iniciarWhatsApp, pararWhatsApp, getStatusWhatsApp, enviarMensagemWhatsApp } = require("./src/whatsapp/index");
const { iniciarAgente } = require("./src/whatsapp/agente");
const { startAsaasPoller } = require("./src/services/asaas-poller");
const { ensureAsaasWebhook } = require("./src/services/asaas");
const { startHubAsaasEvents } = require("./src/services/hub-asaas-events");

const app = express();

// ─── SSE ─────────────────────────────────────────────────────────────────────
const _sseClients = new Set();

function sseEmit(tipo, data = {}) {
  if (_sseClients.size === 0) return;
  const payload = JSON.stringify({ tipo, ts: Date.now(), ...data });
  for (const res of _sseClients) res.write(`data: ${payload}\n\n`);
  console.log(`[SSE] "${tipo}" → ${_sseClients.size} cliente(s)`);
}

ceiaEmitter.on("ceia:sync-ok", (stats) => {
  sseEmit("vitrine_atualizada", { stats });
  _vitrineInfoCacheTime = 0; // invalida cache para próximo /api/vitrine/info
});

// Bridge: eventos do bot Telegram → SSE para a UI
ceiaEmitter.on("ceia:sse", ({ tipo, data }) => {
  sseEmit(tipo, data);
});

// Quando motoboy aceita a rota → envia código de entrega para os CLIENTES via WhatsApp.
// O motoboy NÃO recebe o código — ele pede ao cliente na entrega e digita no Telegram para dar baixa.
ceiaEmitter.on("ceia:sse", ({ tipo, data }) => {
  if (tipo !== 'ACEITE_ROTA' || !data?.pacote_id) return;
  (async () => {
    try {
      const { db: rawDb } = require('./src/data/db');
      const pedidos = await new Promise((resolve, reject) =>
        rawDb.all('SELECT * FROM pedidos WHERE pacote_id = ?', [data.pacote_id], (e, rows) => e ? reject(e) : resolve(rows || []))
      );
      for (const p of pedidos) {
        if (!p.cliente_whatsapp) continue;
        const msg = `Seu pedido saiu para entrega! 🛵\n\nO motoboy está a caminho. Fique de olho!`;
        await enviarMensagemWhatsApp(p.cliente_whatsapp, msg)
          .catch(e => console.warn(`[WA] Falha ao enviar notificação de despacho para ${p.cliente_whatsapp}:`, e.message));
        console.log(`[WA] Notificação de despacho enviada para ${p.cliente_whatsapp} (pedido ${p.id})`);
      }
    } catch (e) {
      console.error('[WA] Erro ao enviar códigos de entrega:', e.message);
    }
  })();
});

// ─── Cache vitrine info ───────────────────────────────────────────────────────
let _vitrineInfoCache     = null;
let _vitrineInfoCacheTime = 0;
const db = new sqlite3.Database("ceia.db");

// ── SQLite: WAL mode + busy retry (espelho da conexão em db.js) ───────────────
db.run("PRAGMA journal_mode=WAL", (err) => {
  if (err) console.error("[SERVER-DB] Erro ao ativar WAL:", err.message);
});
db.run("PRAGMA busy_timeout=5000");
db.get("PRAGMA journal_mode", (err, row) => {
  if (err) console.error("[SERVER-DB] Erro ao verificar journal_mode:", err.message);
  else console.log(`[SERVER-DB] journal_mode ativo: ${row.journal_mode}`);
});

// ─── Upload middleware ─────────────────────────────────────────────────────────
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  },
});
const uploadImg = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = [".jpg", ".jpeg", ".png", ".webp"].includes(
      path.extname(file.originalname).toLowerCase()
    );
    ok ? cb(null, true) : cb(new Error("Formato não suportado. Use JPG, PNG ou WEBP."));
  },
});

app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static(uploadsDir));

app.get("/orders", (req, res) => {
  db.all("SELECT * FROM orders ORDER BY created_at DESC", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.patch("/orders/:id/status", (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  db.run(
    "UPDATE orders SET status = ? WHERE id = ?",
    [status, id],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      // envia resposta primeiro
      res.json({
        updated: this.changes,
        order_id: id,
        new_status: status,
      });

      // depois envia mensagem se estiver READY
      if (status === "READY") {
        db.get(
          "SELECT customer_phone FROM orders WHERE id = ?",
          [id],
          async (err, row) => {
            if (!err && row) {
              await sendMessage(
                row.customer_phone,
                "🍣 Seu pedido está pronto! Obrigado por escolher o CEIA."
              );
            }
          }
        );
      }
    }
  );
});

// --- ROTAS DO MAPA E ZONAS DE ENTREGA ---

// 1. Guardar uma nova zona de entrega (Polígono ou Raio)
app.post("/zones", (req, res) => {
  const { name, coordinates_json, shipping_fee, minimum_order, prep_time } = req.body;

  db.run(
    `INSERT INTO delivery_zones (name, coordinates_json, shipping_fee, minimum_order, prep_time)
     VALUES (?, ?, ?, ?, ?)`,
    [name, coordinates_json, shipping_fee, minimum_order, prep_time],
    function (err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, message: "Zona de entrega guardada com sucesso!" });
    }
  );
});

// 2. Carregar todas as zonas de entrega para desenhar no mapa
app.get("/zones", (req, res) => {
  db.all("SELECT * FROM delivery_zones ORDER BY created_at DESC", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ─── Vitrine Digital ──────────────────────────────────────────────────────────

app.get("/api/vitrine/status", (_req, res) => {
  res.json(getSyncStatus());
});

app.post("/api/vitrine/token", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ ok: false, error: "Token não informado" });
  process.env.CEIA_NODE_TOKEN = token;
  await setConfig("CEIA_NODE_TOKEN", token);
  // Dispara sync imediato para validar
  syncCardapio().catch(e => console.error('[SERVER] falha em syncCardapio (trigger token):', e.message));
  res.json({ ok: true });
});

app.get("/api/vitrine/testar", async (_req, res) => {
  const r = await vitrineFetch("/node/info");
  if (!r) return res.json({ ok: false, error: "Token inválido ou sem conexão" });
  try {
    const data = await r.json();
    // Persiste slug e nome para o agente (cfg.vitrine_slug) e para sincronizarVitrine()
    if (data.loja?.slug) {
      await setConfig("vitrine_slug", data.loja.slug).catch(e => console.error('[SERVER] falha em setConfig(vitrine_slug):', e.message));
      if (data.loja?.nome) await setConfig("vitrine_loja_nome", data.loja.nome).catch(e => console.error('[SERVER] falha em setConfig(vitrine_loja_nome):', e.message));
    }
    const url = data.url || (data.loja?.slug ? `https://${data.loja.slug}.ceia.ia.br/` : null);
    res.json({ ok: true, loja: data.loja, url });
  } catch {
    res.json({ ok: false, error: "Resposta inválida do servidor Ceia" });
  }
});

app.post("/api/vitrine/sync", async (_req, res) => {
  console.log('[VITRINE] rota de sync acionada');
  try {
    const stats = await sincronizarVitrine();
    if (!stats) return res.json({ ok: false, error: "Falha no sync — verifique o token e a conexão" });
    res.json({ ok: true, stats });
  } catch (err) {
    console.error('[VITRINE] erro inesperado na rota /sync:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/vitrine/info", async (_req, res) => {
  const token = process.env.CEIA_NODE_TOKEN;
  if (!token) return res.json({ conectado: false, motivo: "sem_token" });

  const now = Date.now();
  if (_vitrineInfoCache && (now - _vitrineInfoCacheTime < 30_000)) {
    const status = getSyncStatus();
    return res.json({ ..._vitrineInfoCache, ultimo_sync: status.ultimoSync?.ts || _vitrineInfoCache.ultimo_sync });
  }

  const r = await vitrineFetch("/node/info").catch(() => null);
  if (!r) return res.json({ conectado: false, motivo: "wp_offline" });

  try {
    const data = await r.json();
    const status = getSyncStatus();
    // url_publica deve ser uma URL absoluta (https://...). O Hub pode retornar o
    // filename do logo ou um caminho relativo por engano — nesses casos, cair no
    // fallback slug-based evita que o iframe receba um src relativo que o Electron
    // resolve como file:// e dispara ERR_FILE_NOT_FOUND.
    const rawUrl = data.loja?.url_publica;
    const validUrl = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
    const result = {
      conectado: true,
      slug:       data.loja?.slug  || null,
      nome:       data.loja?.nome  || null,
      url:        validUrl || (data.loja?.slug ? `https://${data.loja.slug}.ceia.ia.br/` : null),
      ultimo_sync: status.ultimoSync?.ts || null,
    };
    _vitrineInfoCache     = result;
    _vitrineInfoCacheTime = now;
    res.json(result);
  } catch {
    res.json({ conectado: false, motivo: "wp_offline" });
  }
});

app.get("/api/eventos", (req, res) => {
  res.setHeader("Content-Type",     "text/event-stream");
  res.setHeader("Cache-Control",    "no-cache");
  res.setHeader("Connection",       "keep-alive");
  res.setHeader("X-Accel-Buffering","no"); // desativa buffer do nginx (se houver proxy)

  // Desativa timeout do socket para essa conexão longa (SSE fica aberta por minutos/horas)
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 0);

  res.flushHeaders();

  // Informa ao cliente pra reconectar em 3s se cair (padrão do browser é 3-5s)
  res.write("retry: 3000\n\n");

  _sseClients.add(res);
  console.log(`[SSE] cliente conectado (total: ${_sseClients.size})`);

  // Heartbeat a cada 15s — mais conservador que 30s (proxies costumam ter timeout de 30-60s)
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) {}
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    _sseClients.delete(res);
    console.log(`[SSE] cliente desconectado (total: ${_sseClients.size})`);
  });
});

// ─── Onboarding ───────────────────────────────────────────────────────────────

app.get("/api/onboarding/status", async (_req, res) => {
  const val = await getConfig("vitrine_configurada").catch(() => null);
  res.json({ configurado: val === "true" });
});

app.post("/api/onboarding/token", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ ok: false, error: "Token não informado" });

  process.env.CEIA_NODE_TOKEN = token;
  // TODO(causa-2): considerar propagar/alertar — falha aqui perde o token após reinício
  await setConfig("CEIA_NODE_TOKEN", token).catch(e => console.error('[SERVER] falha em setConfig(CEIA_NODE_TOKEN):', e.message));

  const r = await vitrineFetch("/node/info");
  if (!r) return res.json({ ok: false, error: "Token inválido ou sem conexão com o Ceia" });

  try {
    const data = await r.json();
    res.json({ ok: true, loja: data.loja, url: data.url || `https://${data.slug}.ceia.ia.br/` });
  } catch {
    res.json({ ok: false, error: "Resposta inválida do servidor Ceia" });
  }
});

app.post("/api/onboarding/asaas", async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.json({ ok: false, error: "Chave não informada" });
  process.env.ASAAS_API_KEY = key;
  // TODO(causa-2): considerar propagar/alertar — falha aqui perde chave Asaas após reinício
  await setConfig("ASAAS_API_KEY", key).catch(e => console.error('[SERVER] falha em setConfig(ASAAS_API_KEY):', e.message));
  // Mantém asaas_env em sincronia com o prefixo da chave (para exibição na UI)
  const envDerived = key.startsWith('$aact_prod_') ? 'producao' : 'sandbox';
  await setConfig("asaas_env", envDerived).catch(e => console.error('[SERVER] falha em setConfig(asaas_env):', e.message));
  res.json({ ok: true });
});

app.post("/api/onboarding/openai", async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.json({ ok: false, error: "Chave não informada" });
  process.env.OPENAI_API_KEY = key;
  // TODO(causa-2): considerar propagar/alertar — falha aqui perde chave OpenAI após reinício
  await setConfig("OPENAI_API_KEY", key).catch(e => console.error('[SERVER] falha em setConfig(OPENAI_API_KEY):', e.message));
  res.json({ ok: true });
});

app.post("/api/onboarding/finalizar", async (_req, res) => {
  await setConfig("vitrine_configurada", "true").catch(e => console.error('[SERVER] falha em setConfig(vitrine_configurada):', e.message));
  // Inicia sincronização se token estiver configurado
  startVitrineSync();
  res.json({ ok: true });
});

// ─── Rotas Fase 2 ─────────────────────────────────────────────────────────────
const rotasCategorias = require('./src/routes/categorias');
const rotaImportIA    = require('./src/routes/cardapio-import');
app.use('/api/categorias', rotasCategorias);
app.use('/api/cardapio/importar-ia', rotaImportIA);

// ─── Cardápio (CRUD via API) ─────────────────────────────────────────────────
// Importado aqui para não quebrar a ordem de inicialização do db
const dbFull = require("./src/data/db");

app.get("/api/cardapio/categorias", async (_req, res) => {
  res.json(await dbFull.getCategorias());
});
app.post("/api/cardapio/categorias", async (req, res) => {
  await dbFull.saveCategoria(req.body);
  agendarSyncVitrine('categoria');
  res.json({ ok: true });
});
app.delete("/api/cardapio/categorias/:id", async (req, res) => {
  await dbFull.deleteCategoria(req.params.id);
  agendarSyncVitrine('categoria');
  res.json({ ok: true });
});

app.get("/api/cardapio/produtos", async (_req, res) => {
  res.json(await dbFull.getProdutos());
});
app.get("/api/produtos/todos", async (_req, res) => {
  try { res.json(await dbFull.getProdutosTodos()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/cardapio/produtos", async (req, res) => {
  await dbFull.saveProduto(req.body);
  agendarSyncVitrine('produto');
  res.json({ ok: true });
});
app.delete("/api/cardapio/produtos/:id", async (req, res) => {
  await dbFull.deleteProduto(req.params.id);
  agendarSyncVitrine('produto');
  res.json({ ok: true });
});

app.get("/api/cardapio/adicionais", async (_req, res) => {
  res.json(await dbFull.getAdicionais());
});
app.post("/api/cardapio/adicionais", async (req, res) => {
  try { await dbFull.saveAdicional(req.body); console.log('[VITRINE] sync automático após adicional'); agendarSyncVitrine('adicional'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/cardapio/adicionais/:id", async (req, res) => {
  try {
    await dbFull.saveAdicional({ ...req.body, id: parseInt(req.params.id) });
    console.log('[VITRINE] sync automático após adicional');
    agendarSyncVitrine('adicional');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/cardapio/adicionais/:id", async (req, res) => {
  try { await dbFull.deleteAdicional(req.params.id); console.log('[VITRINE] sync automático após adicional'); agendarSyncVitrine('adicional'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/cardapio/bairros", async (_req, res) => {
  res.json(await dbFull.getBairros());
});
app.post("/api/cardapio/bairros", async (req, res) => {
  await dbFull.saveBairro(req.body);
  agendarSyncVitrine('bairro');
  res.json({ ok: true });
});
app.delete("/api/cardapio/bairros/:id", async (req, res) => {
  await dbFull.deleteBairro(req.params.id);
  agendarSyncVitrine('bairro');
  res.json({ ok: true });
});

// ─── Impressoras ──────────────────────────────────────────────────────────────

function _lpstatPrinters() {
  const { exec } = require("child_process");
  return new Promise(resolve => {
    exec("lpstat -p", (err, stdout) => {
      if (err || !stdout?.trim()) return resolve([]);
      const printers = [];
      for (const line of (stdout || '').split("\n")) {
        const m = line.match(/^impressora\s+(\S+)/i) || line.match(/^printer\s+(\S+)/i);
        if (m) printers.push({ id: m[1], nome: m[1].replace(/_/g, ' '), padrao: false, status: 'ativa' });
      }
      resolve(printers);
    });
  });
}

app.get("/api/impressoras", async (_req, res) => {
  try {
    let printers = [];
    try {
      const ptp = require("pdf-to-printer");
      const raw = await ptp.getPrinters();
      if (Array.isArray(raw) && raw.length > 0) {
        printers = raw.map(p => ({
          id: (p.name || '').replace(/\s+/g, '_'),
          nome: p.displayName || p.name || '',
          padrao: !!p.isDefault,
          status: 'ativa',
        }));
      }
    } catch (_) {
      printers = await _lpstatPrinters();
    }
    res.json(printers);
  } catch (e) {
    console.error("[impressoras] erro:", e.message);
    res.json([]);
  }
});

// ─── Upload de imagens ────────────────────────────────────────────────────────

app.post("/api/uploads", uploadImg.single("arquivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo recebido" });
  const port = process.env.PORT || 3000;
  const url = `http://127.0.0.1:${port}/uploads/${req.file.filename}`;
  res.json({ ok: true, url });
});

// ─── Produtos Fase 3 ──────────────────────────────────────────────────────────

app.get("/api/categorias/:id/produtos", async (req, res) => {
  try {
    res.json(await dbFull.getProdutosByCategoria(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORTANT: /reorder before /:id to avoid "reorder" being captured as an id
app.post("/api/produtos/reorder", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids deve ser array" });
  try {
    await dbFull.reorderProdutos(ids);
    console.log('[VITRINE] sync automático após reordenar-produtos');
    agendarSyncVitrine('reordenar-produtos');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/produtos", async (req, res) => {
  try {
    await dbFull.saveProduto(req.body);
    console.log('[VITRINE] sync automático após produto');
    agendarSyncVitrine('produto');
    res.status(201).json({ ok: true, id: req.body.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/produtos/:id", async (req, res) => {
  try {
    await dbFull.patchProduto(req.params.id, req.body);
    if ('esgotado' in req.body) {
      console.log('[VITRINE] sync automático após esgotado');
      agendarSyncVitrine('esgotado');
    } else {
      console.log('[VITRINE] sync automático após produto');
      agendarSyncVitrine('produto');
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/produtos/:id", async (req, res) => {
  try {
    await dbFull.patchProduto(req.params.id, { ativo: 0 });
    console.log('[VITRINE] sync automático após produto');
    agendarSyncVitrine('produto');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/produtos/:id/duplicar", async (req, res) => {
  try {
    const p = await dbFull.duplicarProduto(req.params.id);
    console.log('[VITRINE] sync automático após produto');
    agendarSyncVitrine('produto');
    res.status(201).json({ ok: true, produto: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/produtos/:id/mover", async (req, res) => {
  const { categoria_id } = req.body || {};
  if (!categoria_id) return res.status(400).json({ error: "categoria_id obrigatório" });
  try {
    await dbFull.moverProduto(req.params.id, categoria_id);
    console.log('[VITRINE] sync automático após produto');
    agendarSyncVitrine('produto');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Variações de preço ───────────────────────────────────────────────────────

// IMPORTANT: reorder before /:varId to prevent "reorder" being captured as ID
app.post("/api/produtos/:id/variacoes/reorder", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids deve ser array" });
  try {
    await dbFull.reorderVariacoes(ids);
    console.log('[VITRINE] sync automático após reordenar-variacoes');
    agendarSyncVitrine('reordenar-variacoes');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/produtos/:id/variacoes", async (req, res) => {
  try {
    res.json(await dbFull.getVariacoesByProduto(req.params.id));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/produtos/:id/variacoes", async (req, res) => {
  try {
    const v = await dbFull.saveVariacao({ ...req.body, produto_id: parseInt(req.params.id) });
    console.log('[VITRINE] sync automático após variacao');
    agendarSyncVitrine('variacao');
    res.status(201).json({ ok: true, variacao: v });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/variacoes/:id", async (req, res) => {
  const { nome, preco } = req.body || {};
  try {
    await dbFull.saveVariacao({ id: parseInt(req.params.id), nome, preco });
    console.log('[VITRINE] sync automático após variacao');
    agendarSyncVitrine('variacao');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/variacoes/:id", async (req, res) => {
  try {
    await dbFull.deleteVariacao(req.params.id);
    console.log('[VITRINE] sync automático após variacao');
    agendarSyncVitrine('variacao');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Despacho — Motoboys ─────────────────────────────────────────────────────

app.get('/api/motoboys', async (_req, res) => {
  try { res.json(await dbFull.getMotoboys()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/motoboys', async (req, res) => {
  try { res.json(await dbFull.saveMotoboy(req.body)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/motoboys/:id', async (req, res) => {
  try { res.json(await dbFull.saveMotoboy({ ...req.body, id: +req.params.id })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/motoboys/:id', async (req, res) => {
  try { await dbFull.deleteMotoboy(+req.params.id); res.json({ ok: true }); }
  catch(e) {
    const status = e.message.includes('acerto pendente') ? 409 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ─── Despacho — Pacotes ───────────────────────────────────────────────────────

app.get('/api/pacotes', async (_req, res) => {
  try { res.json(await dbFull.getPacotesAtivos()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pacotes', async (_req, res) => {
  try { res.json(await dbFull.createPacote()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/pacotes/:id', async (req, res) => {
  try { await dbFull.patchPacote(+req.params.id, req.body); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/pacotes/:id', async (req, res) => {
  try {
    const { db } = require('./src/data/db');
    const pac = await new Promise((resolve, reject) =>
      db.get('SELECT status FROM pacotes WHERE id = ?', [+req.params.id], (e, row) => e ? reject(e) : resolve(row))
    );
    if (!pac) return res.status(404).json({ error: 'Pacote não encontrado' });
    if (pac.status === 'em_rota') {
      return res.status(409).json({ error: 'Pacote em rota não pode ser excluído. Cancele a rota primeiro.' });
    }
    await dbFull.deletePacote(+req.params.id);
    res.json({ ok: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Despacho — Pedidos ───────────────────────────────────────────────────────

app.get('/api/pedidos', async (req, res) => {
  try {
    const { status, origem, data_de, data_ate, busca, limit, offset } = req.query;
    const result = await dbFull.getPedidos({ status, origem, data_de, data_ate, busca,
      limit: limit ? +limit : 50, offset: offset ? +offset : 0 });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/pedidos/kanban', async (_req, res) => {
  try { res.json(await dbFull.getPedidosKanban()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pedidos', async (req, res) => {
  // Guards de negócio (causa-5): rejeitar dado inválido antes de chegar ao banco
  const { itens, forma_pagamento } = req.body || {};
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ error: 'Pedido sem itens: adicione ao menos um item.' });
  }
  if (!forma_pagamento || !String(forma_pagamento).trim()) {
    return res.status(400).json({ error: 'Forma de pagamento obrigatória.' });
  }
  try {
    const pedido = await dbFull.createPedido(req.body);
    // Emite SSE para todos os painéis abertos — mesmo evento que o fechar_pedido da IA usa (causa-D)
    sseEmit('pedido_criado', {
      pedido_id:    pedido.id,
      codigo:       pedido.codigo,
      origem:       'manual',
      cliente_nome: pedido.cliente_nome,
    });
    res.json(pedido);
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/pedidos/:id', async (req, res) => {
  try { await dbFull.patchPedido(+req.params.id, req.body); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/pedidos/:id', async (req, res) => {
  try { await dbFull.deletePedido(+req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Despacho — Operação ─────────────────────────────────────────────────────

// POST /api/operacao/despachar — seta pacote como 'aguardando', vincula motoboy, gera códigos e notifica motoboy
app.post('/api/operacao/despachar', async (req, res) => {
  const { pacote_id, motoboy_id } = req.body || {};
  if (!pacote_id || !motoboy_id) return res.status(400).json({ error: 'pacote_id e motoboy_id obrigatórios' });
  try {
    console.log(`[DESPACHO] Despachando pacote ${pacote_id} para motoboy_id ${motoboy_id}`);

    // Guard (causa-5): pacote deve ter ≥1 pedido antes de despachar — evita pacote órfão
    const { db } = require('./src/data/db');
    const _pacoteCount = await new Promise((resolve, reject) =>
      db.get('SELECT COUNT(*) AS n FROM pedidos WHERE pacote_id = ?', [pacote_id], (e, row) => e ? reject(e) : resolve(row?.n || 0))
    );
    if (_pacoteCount === 0) {
      return res.status(400).json({ error: 'Pacote sem pedidos: adicione pedidos antes de despachar.' });
    }

    await dbFull.patchPacote(pacote_id, { status: 'aguardando', motoboy_id, despachado_em: new Date().toISOString() });

    // Busca pedidos do pacote — cada um já tem seu codigo_entrega único gerado no createPedido
    const pedidos = await new Promise((resolve, reject) =>
      db.all('SELECT * FROM pedidos WHERE pacote_id = ?', [pacote_id], (e, rows) => e ? reject(e) : resolve(rows || []))
    );
    console.log(`[DESPACHO] ${pedidos.length} pedido(s) no pacote ${pacote_id} — códigos: ${pedidos.map(p => `#${p.id}=${p.codigo_entrega}`).join(', ')}`);

    // Notifica motoboy via Telegram
    const motoboy = await dbFull.getMotoboy(motoboy_id).catch(() => null);
    console.log(`[DESPACHO] telegram_id resolvido: ${motoboy?.telegram_id || 'NULO'}`);

    let telegram_notified = false;
    let telegram_msg       = null;

    if (!motoboy?.telegram_id) {
      telegram_msg = 'Motoboy não tem Telegram vinculado';
      console.warn(`[DESPACHO] ${telegram_msg} (motoboy_id ${motoboy_id})`);
    } else {
      console.log(`[BOT] enviarRotaParaMotoboy chamado para ${motoboy.telegram_id}`);
      const result = await enviarRotaParaMotoboy(
        motoboy.telegram_id,
        { pacote_id, pedidos, motoboy_nome: motoboy.nome }
      );
      if (result?.sent) {
        telegram_notified = true;
        console.log(`[BOT] sendMessage OK para ${motoboy.telegram_id}`);
      } else {
        telegram_msg = result?.reason || 'Falha ao notificar motoboy no Telegram';
        console.warn(`[BOT] sendMessage FALHOU: ${telegram_msg}`);
      }
    }

    sseEmit('pacote_despachado', { pacote_id, motoboy_id });
    res.json({ ok: true, telegram_notified, telegram_msg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/operacao/confirmar-coleta — motoboy coletou: pacote vai pra em_rota
app.post('/api/operacao/confirmar-coleta', async (req, res) => {
  const { pacote_id } = req.body || {};
  if (!pacote_id) return res.status(400).json({ error: 'pacote_id obrigatório' });
  try {
    // Transação atômica: pacote E pedidos mudam juntos ou nenhum muda (causa-3)
    await dbFull.moverPacoteComPedidos(
      pacote_id,
      { status: 'em_rota', coletado_em: new Date().toISOString() },
      { status: 'em_rota' }
    );
    sseEmit('pacote_em_rota', { pacote_id });
    res.json({ ok: true });
  } catch(e) {
    console.error('[DESPACHO] falha em confirmar-coleta (rollback executado, estado não alterado):', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/operacao/finalizar-entrega — fecha pacote, pedidos viram finalizado
app.post('/api/operacao/finalizar-entrega', async (req, res) => {
  const { pacote_id } = req.body || {};
  if (!pacote_id) return res.status(400).json({ error: 'pacote_id obrigatório' });
  try {
    const now = new Date().toISOString();
    // Transação atômica: pacote E pedidos mudam juntos ou nenhum muda (causa-3)
    await dbFull.moverPacoteComPedidos(
      pacote_id,
      { status: 'finalizado', finalizado_em: now },
      { status: 'finalizado', finalizado_em: now }
    );
    sseEmit('pacote_finalizado', { pacote_id });
    res.json({ ok: true });
  } catch(e) {
    console.error('[DESPACHO] falha em finalizar-entrega (rollback executado, estado não alterado):', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Despacho — Estornos ─────────────────────────────────────────────────────

app.get('/api/estornos', async (req, res) => {
  try {
    const { status, data_de, data_ate } = req.query;
    res.json(await dbFull.getEstornos({ status, data_de, data_ate }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/estornos', async (req, res) => {
  const { pedido_id, valor, motivo } = req.body || {};
  if (!pedido_id || !valor || !motivo) return res.status(400).json({ error: 'pedido_id, valor e motivo obrigatórios' });
  try {
    const pedido = await dbFull.getPedidos({ busca: '' });
    // busca pedido direto
    const { db } = require('./src/data/db');
    const ped = await new Promise((res, rej) =>
      db.get("SELECT * FROM pedidos WHERE id=?", [pedido_id], (e,r) => e ? rej(e) : res(r))
    );
    if (!ped) return res.status(404).json({ error: 'Pedido não encontrado' });

    let asaasRefundId = null;
    let estornoStatus = 'pendente';
    let asaasError = null;

    if (ped.asaas_payment_id) {
      try {
        const asaasKey = await dbFull.getConfig('asaas_key').catch(() => null) || process.env.ASAAS_API_KEY;
        const asaasBase = (asaasKey && asaasKey.startsWith('$aact_prod_'))
          ? 'https://api.asaas.com'
          : 'https://sandbox.asaas.com';
        const r = await fetch(`${asaasBase}/api/v3/payments/${ped.asaas_payment_id}/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'access_token': asaasKey },
          body: JSON.stringify({ value: valor, description: motivo }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await r.json();
        if (r.ok && data.id) {
          asaasRefundId = data.id;
          estornoStatus = 'concluido';
        } else {
          asaasError = data.errors?.[0]?.description || data.description || `HTTP ${r.status}`;
          estornoStatus = 'falhou';
        }
      } catch(fetchErr) {
        asaasError = fetchErr.message;
        estornoStatus = 'falhou';
      }
    } else {
      // sem asaas_payment_id — registra como manual/pendente
      estornoStatus = 'concluido';
    }

    const estorno = await dbFull.createEstorno({ pedido_id, valor, motivo, asaas_refund_id: asaasRefundId, status: estornoStatus });

    if (estornoStatus === 'concluido') {
      await dbFull.patchPedido(pedido_id, { status: 'estornado' });
    }

    if (estornoStatus === 'falhou') {
      return res.status(200).json({ ok: false, estorno, error: asaasError });
    }
    res.json({ ok: true, estorno });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Settings — CRUD genérico + testar ───────────────────────────────────────

app.get('/api/settings', async (_req, res) => {
  try {
    const rows = await dbFull.getAllConfig();
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/settings', async (req, res) => {
  const fields = req.body || {};
  const VITRINE_KEYS = ['loja_nome','loja_endereco','loja_telefone','loja_descricao','loja_slogan','loja_cor_primaria','horarios','pedido_minimo','formas_pagamento'];
  try {
    let vitrineChanged = false;
    for (const [key, value] of Object.entries(fields)) {
      const strVal = typeof value === 'string' ? value : JSON.stringify(value);
      await setConfig(key, strVal);
      if (key === 'openai_key' && value) process.env.OPENAI_API_KEY = value;
      if (key === 'asaas_key' && value) {
        process.env.ASAAS_API_KEY = value;
        // Mantém asaas_env em sincronia com o prefixo da chave (só para exibição na UI)
        const envDerived = value.startsWith('$aact_prod_') ? 'producao' : 'sandbox';
        await setConfig('asaas_env', envDerived).catch(e => console.error('[SERVER] falha em setConfig(asaas_env) via config-general:', e.message));
      }
      if (key === 'CEIA_NODE_TOKEN' && value) process.env.CEIA_NODE_TOKEN = value;
      if (key === 'telegram_token') ceiaEmitter.emit('ceia:telegram-token-changed');
      if (VITRINE_KEYS.includes(key)) vitrineChanged = true;
    }
    if (vitrineChanged) { console.log('[VITRINE] sync automático após config-vitrine'); agendarSyncVitrine('config-vitrine'); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMPORTANT: /testar/:tipo before /google_maps_key and /loja_coords to avoid route capture
app.post('/api/settings/testar/:tipo', async (req, res) => {
  const { tipo } = req.params;
  try {
    if (tipo === 'google_maps') {
      const key = await getConfig('google_maps_key').catch(() => null);
      if (!key) return res.json({ ok: false, msg: 'Chave não configurada' });
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=Brasil&key=${key}`, { signal: AbortSignal.timeout(6000) });
      const data = await r.json();
      if (['OK','ZERO_RESULTS'].includes(data.status)) return res.json({ ok: true, msg: 'Chave válida' });
      return res.json({ ok: false, msg: `Erro: ${data.status || 'inválida'}` });
    }
    if (tipo === 'openai') {
      const key = await getConfig('openai_key').catch(() => null) || process.env.OPENAI_API_KEY;
      if (!key) return res.json({ ok: false, msg: 'Chave não configurada' });
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
      return res.json(r.ok ? { ok: true, msg: 'Chave válida' } : { ok: false, msg: 'Chave inválida ou sem permissão' });
    }
    if (tipo === 'asaas') {
      const key = await getConfig('asaas_key').catch(() => null) || process.env.ASAAS_API_KEY;
      if (!key) return res.json({ ok: false, msg: 'Chave não configurada' });
      const base = key.startsWith('$aact_prod_') ? 'https://api.asaas.com' : 'https://sandbox.asaas.com';
      const r = await fetch(`${base}/api/v3/customers?limit=1`, { headers: { 'access_token': key }, signal: AbortSignal.timeout(6000) });
      return res.json(r.ok ? { ok: true, msg: 'Chave válida' } : { ok: false, msg: `HTTP ${r.status}` });
    }
    if (tipo === 'telegram') {
      const token = await getConfig('telegram_token').catch(() => null);
      if (!token) return res.json({ ok: false, msg: 'Token não configurado' });
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
      const data = await r.json();
      return res.json(data.ok ? { ok: true, msg: `Bot: @${data.result.username}` } : { ok: false, msg: data.description || 'Token inválido' });
    }
    res.status(400).json({ ok: false, msg: 'tipo inválido' });
  } catch (e) { res.json({ ok: false, msg: 'Timeout ou erro: ' + e.message }); }
});

app.post('/api/settings/geocodificar', async (req, res) => {
  const { endereco } = req.body || {};
  if (!endereco) return res.status(400).json({ error: 'endereço obrigatório' });
  const key = await getConfig('google_maps_key').catch(() => null);
  if (!key) return res.status(400).json({ error: 'Chave Google Maps não configurada em Chaves de API' });
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(endereco)}&key=${key}&language=pt-BR`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const data = await r.json();
    if (data.status === 'OK' && data.results[0]) {
      const loc = data.results[0].geometry.location;
      const formatted = data.results[0].formatted_address;
      await setConfig('loja_lat', String(loc.lat));
      await setConfig('loja_lng', String(loc.lng));
      res.json({ ok: true, lat: loc.lat, lng: loc.lng, endereco_formatado: formatted });
    } else {
      res.json({ ok: false, error: data.status === 'ZERO_RESULTS' ? 'Endereço não encontrado' : (data.status || 'Erro') });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/logo — upload logo da loja
app.post('/api/settings/logo', uploadImg.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Arquivo não recebido' });
  const relPath = `/uploads/${req.file.filename}`;
  try {
    await setConfig('loja_logo_url', relPath);
    agendarSyncVitrine('config-loja');
    res.json({ ok: true, url: relPath });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Fleet (Fase 9 — Motoboys completo) ──────────────────────────────────────

app.get('/api/fleet', async (_req, res) => {
  try { res.json(await dbFull.getMotoboysFleet()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/fleet/:id', async (req, res) => {
  try { res.json(await dbFull.saveMotoboy({ ...req.body, id: +req.params.id })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fleet/:id', async (req, res) => {
  try { await dbFull.deleteMotoboy(+req.params.id); res.json({ ok: true }); }
  catch(e) {
    const status = e.message.includes('acerto pendente') ? 409 : 500;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/fleet/:id/extrato', async (req, res) => {
  try {
    const m = await dbFull.getMotoboy(+req.params.id);
    if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
    // Se tem telegram_id usa a tabela entregas; caso contrário fallback no JOIN legado
    if (m.telegram_id) {
      res.json(await dbFull.getExtratoMotoboyByTelegramId(m.telegram_id));
    } else {
      res.json(await dbFull.getExtratoMotoboy(+req.params.id));
    }
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fleet/:id/zerar-acerto', async (req, res) => {
  try {
    const m = await dbFull.getMotoboy(+req.params.id);
    if (!m) return res.status(404).json({ error: 'Motoboy não encontrado' });
    if (m.telegram_id) {
      await dbFull.zerarAcertoMotoboyByTelegramId(m.telegram_id);
    } else {
      await dbFull.zerarAcertoMotoboy(+req.params.id);
    }
    res.json({ ok: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fleet/:id/historico', async (req, res) => {
  try { res.json(await dbFull.getHistoricoMotoboy(+req.params.id)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/gerar-token-bot — gera token de convite + valida bot Telegram
app.post('/api/gerar-token-bot', async (req, res) => {
  try {
    const token = await getConfig('telegram_token').catch(() => null);
    if (!token) return res.status(400).json({ ok: false, error: 'Token do Telegram não configurado em Configurações > Chaves de API' });
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ ok: false, error: data.description || 'Bot inválido' });
    const conviteToken = await dbFull.gerarTokenConvite();
    const botUsername  = data.result.username;
    res.json({ ok: true, token: conviteToken, bot_username: botUsername,
      link: `https://t.me/${botUsername}?start=${conviteToken}` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/chat/motoboy — envia mensagem avulsa via Telegram
app.post('/api/chat/motoboy', async (req, res) => {
  const { telegram_id, mensagem } = req.body || {};
  if (!telegram_id || !mensagem) return res.status(400).json({ error: 'telegram_id e mensagem obrigatórios' });
  try {
    const result = await enviarMensagemBot(telegram_id, mensagem);
    if (!result?.sent) return res.status(500).json({ error: result?.reason || 'Falha ao enviar' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SOS / Chat operador → motoboy (Bot-4) ───────────────────────────────────

// POST /api/operacao/sos/reply — operador responde a uma emergência SOS
app.post('/api/operacao/sos/reply', async (req, res) => {
  const { telegram_id, mensagem } = req.body || {};
  if (!telegram_id || !mensagem) return res.status(400).json({ error: 'telegram_id e mensagem obrigatórios' });
  try {
    const result = await enviarMensagemBot(telegram_id, `🔔 *Operador:* ${mensagem}`);
    if (!result?.sent) return res.status(500).json({ error: result?.reason || 'Falha ao enviar' });
    sseEmit('SOS_OP_MSG', { telegram_id, texto: mensagem, from: 'operador' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/operacao/sos/encerrar — operador encerra a emergência
app.post('/api/operacao/sos/encerrar', async (req, res) => {
  const { telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id obrigatório' });
  try {
    await encerrarSessaoBot(telegram_id);
    await enviarMensagemBot(telegram_id, '✅ Emergência encerrada pelo operador. Obrigado!');
    sseEmit('SOS_ENCERRADO', { telegram_id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Settings (Google Maps, loja coords) ─────────────────────────────────────

app.get('/api/settings/google_maps_key', async (_req, res) => {
  const key = await getConfig('google_maps_key').catch(() => null);
  res.json({ key: key || '' });
});

app.post('/api/settings/google_maps_key', async (req, res) => {
  const { key } = req.body || {};
  if (key === undefined) return res.json({ ok: false, error: 'Chave não informada' });
  // TODO(causa-2): considerar propagar/alertar — falha aqui perde chave Maps, geocoding para de funcionar
  await setConfig('google_maps_key', key || '').catch(e => console.error('[SERVER] falha em setConfig(google_maps_key):', e.message));
  res.json({ ok: true });
});

app.get('/api/settings/loja_coords', async (_req, res) => {
  const lat = await getConfig('loja_lat').catch(() => null);
  const lng = await getConfig('loja_lng').catch(() => null);
  res.json({ lat: lat ? parseFloat(lat) : null, lng: lng ? parseFloat(lng) : null });
});

app.post('/api/settings/loja_coords', async (req, res) => {
  const { lat, lng } = req.body || {};
  await setConfig('loja_lat', String(lat || '')).catch(e => console.error('[SERVER] falha em setConfig(loja_lat):', e.message));
  await setConfig('loja_lng', String(lng || '')).catch(e => console.error('[SERVER] falha em setConfig(loja_lng):', e.message));
  res.json({ ok: true });
});

// ─── Zonas de Entrega ─────────────────────────────────────────────────────────

function _pointInPolygon(lat, lng, pontos) {
  let inside = false;
  const n = pontos.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pontos[i].lng, yi = pontos[i].lat;
    const xj = pontos[j].lng, yj = pontos[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function _haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180, dLam = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _isPointInZona(lat, lng, zona) {
  try {
    const geo = typeof zona.geometria === 'string' ? JSON.parse(zona.geometria) : zona.geometria;
    if (zona.tipo === 'poligono') return _pointInPolygon(lat, lng, geo);
    if (zona.tipo === 'circulo') return _haversineMeters(lat, lng, geo.center.lat, geo.center.lng) <= geo.radius;
  } catch (_) {}
  return false;
}

// IMPORTANT: /reorder and /lookup before /:id
app.post('/api/zonas/reorder', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids deve ser array' });
  try { await dbFull.reorderZonas(ids); agendarSyncVitrine('bairro'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zonas/lookup', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat e lng obrigatórios' });
  try {
    const zonas = await dbFull.getZonas();
    const found = zonas.find(z => z.ativa && _isPointInZona(lat, lng, z));
    if (!found) return res.json({ encontrada: false });
    res.json({ encontrada: true, zona: { id: found.id, nome: found.nome, taxa: found.taxa, tempo_min: found.tempo_min, tempo_max: found.tempo_max } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/zonas', async (_req, res) => {
  try { res.json(await dbFull.getZonas()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zonas', async (req, res) => {
  try {
    const zona = await dbFull.saveZona(req.body);
    agendarSyncVitrine('bairro');
    res.status(201).json({ ok: true, zona });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/zonas/:id/testar', async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat === undefined || lng === undefined) return res.status(400).json({ error: 'lat e lng obrigatórios' });
  try {
    const zonas = await dbFull.getZonas();
    const zona = zonas.find(z => z.id === parseInt(req.params.id));
    if (!zona) return res.status(404).json({ error: 'Zona não encontrada' });
    const dentro = _isPointInZona(parseFloat(lat), parseFloat(lng), zona);
    res.json({ dentro, taxa: zona.taxa, tempo_min: zona.tempo_min, tempo_max: zona.tempo_max });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/zonas/:id', async (req, res) => {
  try {
    await dbFull.saveZona({ ...req.body, id: parseInt(req.params.id) });
    agendarSyncVitrine('bairro');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/zonas/:id', async (req, res) => {
  try { await dbFull.deleteZona(req.params.id); agendarSyncVitrine('bairro'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── IA — Gerador de descrição ────────────────────────────────────────────────

let _openaiDesc = null;
function _getOpenAIDesc() {
  if (!_openaiDesc) {
    const OpenAI = require("openai");
    _openaiDesc = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiDesc;
}

app.post("/api/ia/descricao", async (req, res) => {
  const { nome, categoria } = req.body || {};
  if (!nome) return res.status(400).json({ error: "nome obrigatório" });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: "Configure sua chave OpenAI em Configurações" });
  }
  try {
    const completion = await _getOpenAIDesc().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: "Escreva uma descrição curta e apetitosa para o item de cardápio. Máximo 1 frase concisa. Sem clichês como 'delicioso' ou 'saboroso'. Só a descrição, sem aspas.",
        },
        {
          role: "user",
          content: `${nome}${categoria ? ` (${categoria})` : ""}`,
        },
      ],
    });
    const descricao = completion.choices[0]?.message?.content?.trim() || "";
    res.json({ ok: true, descricao });
  } catch(e) {
    console.error("[IA-DESC]", e.message);
    res.status(502).json({ error: "Falha ao gerar descrição" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// Callback de inicialização — restaura configs e arranca vitrine sync
async function onListening() {
  const token = await getConfig("CEIA_NODE_TOKEN").catch(() => null);
  if (token) process.env.CEIA_NODE_TOKEN = token;
  const asaasKey = await getConfig("ASAAS_API_KEY").catch(() => null);
  if (asaasKey) process.env.ASAAS_API_KEY = asaasKey;
  const openaiKey = await getConfig("openai_key").catch(() => null)
    || await getConfig("OPENAI_API_KEY").catch(() => null);
  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
  const configurado = await getConfig("vitrine_configurada").catch(() => null);
  if (configurado === "true" || token) startVitrineSync();
  // Inicia o bot Telegram de forma não-bloqueante (sem token = no-op silencioso)
  iniciarTelegram().catch(e => console.error('[BOT] Erro na inicialização:', e.message));

  // Registra o agente de IA WhatsApp (WA-2a) — deve ser chamado antes de iniciarWhatsApp
  iniciarAgente();

  // Asaas: garante webhook registrado no Hub, inicia poller primário (15s) e backstop (5min)
  ensureAsaasWebhook().catch(e => console.error('[ASAAS] erro no bootstrap do webhook:', e.message));
  startHubAsaasEvents();
  startAsaasPoller();

  // Bootstrap defensivo do WhatsApp:
  // Se há sessão salva em baileys_auth/, reconecta automaticamente sem QR.
  // Se não há sessão, fica em 'desconectado' aguardando conexão manual pela UI.
  // O WhatsApp NUNCA derruba o servidor — qualquer falha é isolada aqui.
  const baileysSessaoExiste = require('fs').existsSync(require('path').join(process.cwd(), 'baileys_auth', 'creds.json'));
  if (baileysSessaoExiste) {
    console.log('[WA] Sessão salva encontrada. Reconectando automaticamente...');
    iniciarWhatsApp().catch(e => console.error('[WA] Falha no bootstrap (servidor continua):', e.message));
  } else {
    console.log('[WA] Sessão não encontrada. Aguardando conexão manual em Configurações → WhatsApp.');
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ─── Bot Telegram ─────────────────────────────────────────────────────────────
app.get('/api/bot/info', (_req, res) => {
  res.json(getBotInfo());
});

// ─── Diagnóstico do agente (debug — sem WhatsApp) ────────────────────────────
// GET /api/debug/agente?termo=temaki
// Retorna o que buscar_produto/listar_categorias retornariam para um dado termo.
// Útil para verificar se os IDs, preços e variações batem com o que a IA recebe.
app.get('/api/debug/agente', async (req, res) => {
  try {
    const [produtosRaw, categorias, bairros, zonas] = await Promise.all([
      db.getProdutosParaAgente(),
      db.getCategorias(),
      db.getBairros(),
      db.getZonas(),
    ]);
    const cardapio = { produtos: produtosRaw, categorias, bairros, zonas };

    const _norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const _fmtBRL = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

    // listar_categorias
    const categoriasMap = {};
    for (const p of cardapio.produtos) {
      const cat = p.categoria || 'Sem categoria';
      if (!categoriasMap[cat]) categoriasMap[cat] = { disponivel: 0, esgotado: 0 };
      if (p.esgotado) categoriasMap[cat].esgotado++; else categoriasMap[cat].disponivel++;
    }
    const listarCategoriasResult = Object.entries(categoriasMap)
      .filter(([, c]) => c.disponivel > 0)
      .map(([nome, c]) => ({ nome, itens_disponiveis: c.disponivel }));

    // buscar_produto por termo
    const termo = _norm(req.query.termo || '');
    const matches = termo
      ? cardapio.produtos.filter(p =>
          _norm(p.nome).includes(termo) ||
          _norm(p.descricao).includes(termo) ||
          _norm(p.categoria).includes(termo)
        )
      : cardapio.produtos.slice(0, 20);

    const buscarResult = matches.map(p => ({
      id:            p.id,
      nome:          p.nome,
      categoria:     p.categoria,
      preco:         p.preco,
      preco_promo:   p.preco_promo,
      esgotado:      p.esgotado,
      tem_variacoes: p.tem_variacoes,
      variacoes:     p.variacoes.map(v => ({ id: v.id, nome: v.nome, preco: v.preco })),
      n_adicionais:  p.adicionais.length,
    }));

    res.json({
      termo_buscado:      termo || '(todos)',
      total_produtos_db:  cardapio.produtos.length,
      listar_categorias:  listarCategoriasResult,
      buscar_resultado:   buscarResult,
      nota: 'Use ?termo=temaki, ?termo=bebida, etc. para simular buscar_produto()',
    });
  } catch (e) {
    res.status(500).json({ erro: e.message, stack: e.stack });
  }
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
// GET /api/whatsapp/status → { status, qr (dataURL), numero, ultimaConexao, erro }
app.get('/api/whatsapp/status', (_req, res) => {
  res.json(getStatusWhatsApp());
});

// POST /api/whatsapp/conectar → inicia conexão / gera QR
app.post('/api/whatsapp/conectar', async (_req, res) => {
  try {
    // Não aguarda — a conexão é assíncrona (QR vem via polling de /status)
    iniciarWhatsApp().catch(e => console.error('[WA] Erro ao conectar:', e.message));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/desconectar → logout + limpa sessão
app.post('/api/whatsapp/desconectar', async (_req, res) => {
  try {
    await pararWhatsApp();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Chamados de atendimento humano (WA-2b) ───────────────────────────────────

// GET /api/chamados → lista chamados abertos
app.get('/api/chamados', async (_req, res) => {
  try {
    const chamados = await getChamadosAbertos();
    res.json({ chamados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chamados/:id → chamado específico com histórico
app.get('/api/chamados/:id', async (req, res) => {
  try {
    const chamado = await getChamado(Number(req.params.id));
    if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado' });
    res.json({ chamado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chamados/:id/mensagem → lojista responde ao cliente
app.post('/api/chamados/:id/mensagem', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'texto obrigatório' });
    const chamado = await getChamado(Number(req.params.id));
    if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado' });
    if (chamado.status !== 'aberto') return res.status(400).json({ error: 'Chamado já encerrado' });

    const result = await enviarMensagemWhatsApp(chamado.numero, texto.trim());
    if (!result.sent) return res.status(503).json({ error: result.reason || 'WhatsApp desconectado' });

    // Adiciona mensagem do lojista ao histórico da conversa
    let historico = [];
    try { historico = JSON.parse(chamado.historico || '[]'); } catch (_) {}
    historico.push({ role: 'assistant', content: `[Lojista] ${texto.trim()}` });
    await upsertConversaWA(chamado.numero, { historico: JSON.stringify(historico) });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chamados/:id/encerrar → fecha chamado, IA reassume
app.post('/api/chamados/:id/encerrar', async (req, res) => {
  try {
    const chamado = await getChamado(Number(req.params.id));
    if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado' });

    await patchChamado(Number(req.params.id), {
      status:       'resolvido',
      resolvido_em: new Date().toISOString(),
    });
    // Remove modo_manual → IA volta a responder este número
    await upsertConversaWA(chamado.numero, { modo_manual: 0 });

    sseEmit('CHAMADO_ENCERRADO', { id: Number(req.params.id), numero: chamado.numero });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Clientes Recentes ────────────────────────────────────────────────────────

// GET /api/atendimentos/clientes → lista clientes visíveis ordenados por último pedido
app.get('/api/atendimentos/clientes', async (_req, res) => {
  try {
    const clientes = await getClientesRecentes();
    res.json({ clientes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/atendimentos/clientes/:whatsapp → info + histórico de pedidos do cliente
app.get('/api/atendimentos/clientes/:whatsapp', async (req, res) => {
  console.log('[ATEND] detalhe whatsapp=', req.params.whatsapp);
  try {
    const { info, pedidos } = await getDetalheClienteRecente(req.params.whatsapp);
    console.log('[ATEND] detalhe resultado: info=', info ? `${info.nome}(${info.total_pedidos} pedidos)` : 'null', 'pedidos=', pedidos.length);
    if (!info) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json({ info, pedidos });
  } catch (e) {
    console.error('[ATEND] detalhe erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/atendimentos/clientes/:whatsapp/ocultar → marca cliente como oculto
app.post('/api/atendimentos/clientes/:whatsapp/ocultar', async (req, res) => {
  try {
    await ocultarClienteRecente(req.params.whatsapp);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/atendimentos/pedidos/:codigo → pedido completo (modal de conferência)
app.get('/api/atendimentos/pedidos/:codigo', async (req, res) => {
  try {
    const pedido = await getPedidoPorCodigo(req.params.codigo.toUpperCase());
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

    // Normaliza os dois formatos de itens
    let itensRaw = [];
    try { itensRaw = JSON.parse(pedido.itens || '[]'); } catch (_) {}
    const itens = itensRaw.map(it => {
      if (it.quantidade !== undefined) {
        // Formato 1 (agente WA): adicionais é string CSV ou null
        const adics = it.adicionais
          ? String(it.adicionais).split(',').map(s => s.trim()).filter(Boolean)
          : [];
        return { nome: it.nome, variacao: it.variacao || null, adicionais: adics,
                 quantidade: it.quantidade, preco_unit: it.preco_unit, subtotal: it.subtotal };
      }
      // Formato 2 (legado): nome, preco, qtd
      return { nome: it.nome, variacao: null, adicionais: [],
               quantidade: it.qtd || 1, preco_unit: it.preco || 0,
               subtotal: (it.preco || 0) * (it.qtd || 1) };
    });

    res.json({
      id:               pedido.id,
      codigo:           pedido.codigo,
      criado_em:        pedido.criado_em,
      finalizado_em:    pedido.finalizado_em,
      status:           pedido.status,
      forma_pagamento:  pedido.forma_pagamento,
      cliente: {
        nome:        pedido.cliente_nome,
        telefone:    pedido.cliente_whatsapp,
        endereco:    pedido.endereco,
        bairro:      pedido.bairro,
        complemento: pedido.complemento,
      },
      itens,
      subtotal:          pedido.subtotal,
      taxa_entrega:      pedido.taxa_entrega,
      desconto_aplicado: pedido.desconto_aplicado || 0,
      total:             pedido.total,
      observacoes:       pedido.observacoes,
    });
  } catch (e) {
    console.error('[ATEND] pedido modal erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/atendimentos/clientes/:whatsapp/mensagem → envia WA via Baileys
app.post('/api/atendimentos/clientes/:whatsapp/mensagem', async (req, res) => {
  const { texto } = req.body || {};
  if (!texto?.trim()) return res.status(400).json({ ok: false, error: 'Texto vazio' });
  const wa = req.params.whatsapp;
  try {
    const result = await enviarMensagemWhatsApp(wa, texto.trim());
    if (!result.sent) {
      const motivo = result.reason === 'whatsapp_desconectado'
        ? 'WhatsApp desconectado. Conecte primeiro.'
        : (result.reason || 'Falha ao enviar');
      console.warn('[ATEND] falha ao enviar msg para', wa, '—', result.reason);
      return res.json({ ok: false, error: motivo });
    }
    // Persiste no thread e zera não-lidas (atendente leu ao responder)
    // TODO(causa-2): considerar propagar/alertar — falha aqui perde msg do atendente no histórico do chat
    await addMensagemWAChat(wa, 'atendente', texto.trim()).catch(e => console.error('[SERVER] falha em addMensagemWAChat (atendente):', e.message));
    await marcarMensagensLidas(wa).catch(e => console.error('[SERVER] falha em marcarMensagensLidas:', e.message));
    sseEmit('MENSAGEM_ATENDENTE', { numero: wa, texto: texto.trim() });
    console.log('[ATEND] msg enviada para', wa);
    res.json({ ok: true });
  } catch (e) {
    console.error('[ATEND] erro ao enviar msg:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/atendimentos/clientes/:whatsapp/chat → thread de mensagens + modo_manual
app.get('/api/atendimentos/clientes/:whatsapp/chat', async (req, res) => {
  const wa = req.params.whatsapp;
  try {
    const [msgs, conversa] = await Promise.all([
      getMensagensWAChat(wa),
      getConversaWA(wa),
    ]);
    res.json({ msgs, modo_manual: !!(conversa?.modo_manual) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/atendimentos/clientes/:whatsapp/assumir → pausa IA, ativa modo humano
app.post('/api/atendimentos/clientes/:whatsapp/assumir', async (req, res) => {
  const wa = req.params.whatsapp;
  try {
    await upsertConversaWA(wa, { modo_manual: 1 });
    sseEmit('ATENDIMENTO_ASSUMIDO', { numero: wa });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/atendimentos/clientes/:whatsapp/devolver-ia → IA volta a responder
app.post('/api/atendimentos/clientes/:whatsapp/devolver-ia', async (req, res) => {
  const wa = req.params.whatsapp;
  try {
    await upsertConversaWA(wa, { modo_manual: 0, msgs_nao_lidas: 0 });
    sseEmit('ATENDIMENTO_DEVOLVIDO', { numero: wa });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/atendimentos/clientes/:whatsapp/ler → zera contador de não-lidas
app.post('/api/atendimentos/clientes/:whatsapp/ler', async (req, res) => {
  try {
    await marcarMensagensLidas(req.params.whatsapp);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/atendimentos/pendentes → contagem para badge (modo_manual + nao_lidas)
app.get('/api/atendimentos/pendentes', async (_req, res) => {
  try {
    const count = await getAtendimentosPendentesCount();
    res.json({ count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Diagnóstico de pedidos (debug) ─────────────────────────────────────────
// GET /api/debug/pedidos-recentes
// Retorna os últimos 10 pedidos criados (qualquer status), para confirmar se
// o fechar_pedido chegou a criar o registro no banco.
app.get('/api/debug/pedidos-recentes', async (_req, res) => {
  try {
    const result = await dbFull.getPedidos({ limit: 10, status: 'todos' });
    res.json({ total: result.total, pedidos: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Marketing Fase 1 ────────────────────────────────────────────────────────

// GET /api/marketing/clientes-elegiveis
// Query params (todos opcionais):
//   min_pedidos, dias_sem_pedir, min_total_gasto, min_ticket_medio,
//   formas_pagamento (csv), zonas_excluidas (csv)
app.get('/api/marketing/clientes-elegiveis', async (req, res) => {
  try {
    const q = req.query;
    const criterios = {};
    if (q.min_pedidos      != null) criterios.min_pedidos      = Number(q.min_pedidos);
    if (q.dias_sem_pedir   != null) criterios.dias_sem_pedir   = Number(q.dias_sem_pedir);
    if (q.min_total_gasto  != null) criterios.min_total_gasto  = Number(q.min_total_gasto);
    if (q.min_ticket_medio != null) criterios.min_ticket_medio = Number(q.min_ticket_medio);
    if (q.formas_pagamento)
      criterios.formas_pagamento = q.formas_pagamento.split(',').map(s => s.trim()).filter(Boolean);
    if (q.zonas_excluidas)
      criterios.zonas_excluidas = q.zonas_excluidas.split(',').map(s => s.trim()).filter(Boolean);

    const resultado = await dbFull.getClientesElegiveis(criterios);
    res.json(resultado);
  } catch (e) {
    console.error('[Marketing] getClientesElegiveis erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/marketing/recalcular
// Dispara o backfill completo de todos os clientes (uso administrativo).
app.get('/api/marketing/recalcular', async (_req, res) => {
  try {
    const total = await dbFull.recalcularTodosClientes();
    res.json({ ok: true, clientes_processados: total });
  } catch (e) {
    console.error('[Marketing] recalcularTodosClientes erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Marketing Fase 2 — CRUD promoções e cupons ───────────────────────────────

app.get('/api/marketing/promocoes', async (req, res) => {
  try {
    const rows = await dbFull.getPromocoes(req.query.tipo || null);
    // Enriquece cada promoção com o total de elegíveis atuais
    const enriched = await Promise.all(rows.map(async (p) => {
      try {
        const criterios = _promocaoCriterios(p);
        const { total } = await dbFull.getClientesElegiveis(criterios);
        return { ...p, elegiveis_agora: total };
      } catch (_) {
        return { ...p, elegiveis_agora: null };
      }
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketing/promocoes', async (req, res) => {
  try {
    const p = await dbFull.createPromocao(req.body);
    // Promoção pública afeta a vitrine → dispara sync
    if (p.visibilidade === 'publica') { console.log('[VITRINE] sync automático após promocao'); agendarSyncVitrine('promocao'); }
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/marketing/promocoes/:id', async (req, res) => {
  try {
    const p = await dbFull.updatePromocao(Number(req.params.id), req.body);
    // Sempre dispara sync: pode ter mudado de segmentada→pública ou vice-versa
    console.log('[VITRINE] sync automático após promocao');
    agendarSyncVitrine('promocao');
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/marketing/promocoes/:id', async (req, res) => {
  try {
    await dbFull.deletePromocao(Number(req.params.id));
    console.log('[VITRINE] sync automático após promocao');
    agendarSyncVitrine('promocao');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/marketing/promocoes/preview-elegiveis
// Recebe critérios do editor (sem salvar) e retorna { total }
app.post('/api/marketing/promocoes/preview-elegiveis', async (req, res) => {
  try {
    const criterios = _promocaoCriterios(req.body);
    const { total } = await dbFull.getClientesElegiveis(criterios);
    res.json({ total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/marketing/promocoes-publicas — feed para a vitrine (Fase 3 vitrine)
app.get('/api/marketing/promocoes-publicas', async (req, res) => {
  try {
    const rows = await dbFull.getPromocoesPublicas();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: extrai critérios de elegibilidade de uma promoção/payload
function _promocaoCriterios(p) {
  const c = {};
  if (p.min_pedidos      != null && p.min_pedidos      !== '') c.min_pedidos      = Number(p.min_pedidos);
  if (p.dias_sem_pedir   != null && p.dias_sem_pedir   !== '') c.dias_sem_pedir   = Number(p.dias_sem_pedir);
  if (p.min_total_gasto  != null && p.min_total_gasto  !== '') c.min_total_gasto  = Number(p.min_total_gasto);
  if (p.min_ticket_medio != null && p.min_ticket_medio !== '') c.min_ticket_medio = Number(p.min_ticket_medio);
  if (Array.isArray(p.formas_pagamento)  && p.formas_pagamento.length)  c.formas_pagamento  = p.formas_pagamento;
  if (Array.isArray(p.zonas_excluidas)   && p.zonas_excluidas.length)   c.zonas_excluidas   = p.zonas_excluidas;
  return c;
}

// ─── Relatórios / Analytics ──────────────────────────────────────────────────

// helper para parse de itens (dois formatos)
function _normItens(itensJson) {
  let raw = [];
  try { raw = JSON.parse(itensJson || '[]'); } catch (_) {}
  return raw.map(it => ({
    nome:       it.nome,
    quantidade: it.quantidade ?? it.qtd ?? 1,
    preco_unit: it.preco_unit ?? it.preco ?? 0,
    subtotal:   it.subtotal ?? ((it.preco_unit ?? it.preco ?? 0) * (it.quantidade ?? it.qtd ?? 1)),
    adicionais: it.adicionais ? String(it.adicionais).split(',').map(s=>s.trim()).filter(Boolean) : [],
  }));
}

app.get('/api/relatorios/heatmap', async (req, res) => {
  try { res.json(await analiticoHeatmap(req.query.dias || 30)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/abc', async (req, res) => {
  try {
    const pedidos = await analiticoPedidosRaw(req.query.dias || 30);
    const map = new Map();
    for (const p of pedidos) {
      for (const it of _normItens(p.itens)) {
        const e = map.get(it.nome) || { nome: it.nome, unidades: 0, receita: 0 };
        e.unidades += it.quantidade;
        e.receita  += it.subtotal;
        map.set(it.nome, e);
      }
    }
    const items = [...map.values()].sort((a,b) => b.receita - a.receita).slice(0,30);
    const tot = items.reduce((s,i) => s + i.receita, 0);
    let acum = 0;
    const result = items.map(i => ({ ...i, pct_acum: tot > 0 ? (acum += i.receita) / tot * 100 : 0 }));
    res.json({ items: result, total_receita: tot });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/encalhe', async (req, res) => {
  try {
    const [produtos, pedidos] = await Promise.all([
      analiticoProdutosAtivos(),
      analiticoPedidosRaw(req.query.dias || 90),
    ]);
    // Build lookup: nome → { ultima_venda, unidades }
    const lookup = new Map();
    for (const p of pedidos) {
      for (const it of _normItens(p.itens)) {
        const e = lookup.get(it.nome) || { ultima_venda: null, unidades: 0 };
        if (!e.ultima_venda || p.criado_em > e.ultima_venda) e.ultima_venda = p.criado_em;
        e.unidades += it.quantidade;
        lookup.set(it.nome, e);
      }
    }
    const agora = Date.now();
    const result = produtos.map(p => {
      const s = lookup.get(p.nome) || { ultima_venda: null, unidades: 0 };
      const diasSemVenda = s.ultima_venda
        ? Math.floor((agora - new Date(s.ultima_venda).getTime()) / 86400000)
        : null;
      return { ...p, ultima_venda: s.ultima_venda, unidades: s.unidades, dias_sem_venda: diasSemVenda };
    }).sort((a,b) => (b.dias_sem_venda ?? 9999) - (a.dias_sem_venda ?? 9999));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/zonas', async (req, res) => {
  try { res.json(await analiticoZonas(req.query.dias || 30)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/pagamentos', async (req, res) => {
  try { res.json(await analiticoPagamentos(req.query.dias || 30)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/attach-rate', async (req, res) => {
  try {
    const pedidos = await analiticoPedidosRaw(req.query.dias || 30);
    const adicCount = new Map();
    const totalPedidos = pedidos.length;
    for (const p of pedidos) {
      const adicsNoPedido = new Set();
      for (const it of _normItens(p.itens)) {
        for (const a of it.adicionais) adicsNoPedido.add(a);
      }
      for (const a of adicsNoPedido) adicCount.set(a, (adicCount.get(a)||0)+1);
    }
    const result = [...adicCount.entries()]
      .map(([nome,count]) => ({ nome, count, pct: totalPedidos > 0 ? count/totalPedidos*100 : 0 }))
      .sort((a,b) => b.pct - a.pct).slice(0,20);
    res.json({ total_pedidos: totalPedidos, adicionais: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/promocoes', async (req, res) => {
  try { res.json(await analiticoPromocoes(req.query.dias || 30)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/relatorios/recompra', async (req, res) => {
  try {
    const rows = await analiticoRecompra();
    const dist = { '1': 0, '2-3': 0, '4+': 0 };
    for (const r of rows) {
      if (r.total_pedidos === 1) dist['1']++;
      else if (r.total_pedidos <= 3) dist['2-3']++;
      else dist['4+']++;
    }
    const total = rows.length;
    res.json({
      total_clientes: total,
      distribuicao: Object.entries(dist).map(([faixa, n]) => ({
        faixa, clientes: n, pct: total > 0 ? n/total*100 : 0
      })),
      clientes: rows.map(r => ({ total_pedidos: r.total_pedidos, primeiro_pedido: r.primeiro_pedido, ultimo_pedido: r.ultimo_pedido })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`🚀 CEIA API rodando em http://localhost:${PORT}`);
    await onListening();
  });
}

module.exports = { app, onListening };
