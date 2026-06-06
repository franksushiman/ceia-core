/**
 * rastreamento.js
 * A cada 90s, envia atualização de posição do motoboy ao cliente
 * para pedidos com status 'OUT_FOR_DELIVERY'.
 *
 * Pré-requisito: GOOGLE_MAPS_API_KEY no .env
 */

require("dotenv").config();

const { db } = require("../data/db");
const { sendMessage } = require("../whatsapp/socket");

const INTERVALO_MS = 90_000;
const DELTA_MINIMO_METROS = 500;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Armazena a última distância enviada por pedido para evitar spam
const ultimaDistancia = {}; // orderId -> metros

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

// ─── Distance Matrix API ──────────────────────────────────────────────────────
async function calcularDistancia(origemLat, origemLng, destinoEndereco) {
  if (!GOOGLE_KEY) {
    console.warn("[RASTREAMENTO] GOOGLE_MAPS_API_KEY não configurada");
    return null;
  }

  const origem = `${origemLat},${origemLng}`;
  const destino = encodeURIComponent(destinoEndereco);
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${origem}&destinations=${destino}&key=${GOOGLE_KEY}&language=pt-BR`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    const data = await res.json();
    const element = data.rows?.[0]?.elements?.[0];
    if (element?.status !== "OK") return null;

    return {
      metros:   element.distance.value,
      km:       (element.distance.value / 1000).toFixed(1),
      duracao:  Math.ceil(element.duration.value / 60), // minutos
    };
  } catch (err) {
    console.error("[RASTREAMENTO] erro Distance Matrix:", err.message);
    return null;
  }
}

// ─── Posição do motoboy ───────────────────────────────────────────────────────
// Esta função lê a posição atual do motoboy do banco.
// A tabela 'motoboys' precisa ter: id, nome, lat, lng, token_publico (opcional).
// Adapte conforme a estrutura real do seu banco.
async function getPosicaoMotoboy(motoboyId) {
  return dbGet(
    "SELECT lat, lng, nome FROM motoboys WHERE id = ? AND lat IS NOT NULL",
    [motoboyId]
  );
}

// ─── Pedidos ativos em rota ───────────────────────────────────────────────────
async function getPedidosEmRota() {
  // Adapte conforme seus campos reais:
  // - motoboy_id: quem está entregando
  // - customer_phone: JID do cliente
  // - customer_address: endereço de entrega
  // - token_publico: token para link de rastreio
  return dbAll(
    `SELECT id, customer_phone, customer_address, motoboy_id, token_publico
     FROM orders
     WHERE status = 'OUT_FOR_DELIVERY'
       AND motoboy_id IS NOT NULL
       AND customer_phone IS NOT NULL`
  );
}

// ─── Ciclo de rastreamento ────────────────────────────────────────────────────
async function tick() {
  const pedidos = await getPedidosEmRota().catch(() => []);

  for (const pedido of pedidos) {
    try {
      const motoboy = await getPosicaoMotoboy(pedido.motoboy_id);
      if (!motoboy) continue;

      const dist = await calcularDistancia(
        motoboy.lat,
        motoboy.lng,
        pedido.customer_address
      );
      if (!dist) continue;

      const anterior = ultimaDistancia[pedido.id] ?? Infinity;
      const delta = Math.abs(anterior - dist.metros);

      if (delta < DELTA_MINIMO_METROS && anterior !== Infinity) {
        // Mudança menor que 500m — não envia
        continue;
      }

      ultimaDistancia[pedido.id] = dist.metros;

      const primeiraMsg = anterior === Infinity;
      let texto =
        `🛵 Seu motoboy está a ${dist.km} km e chega em ~${dist.duracao} min.`;

      if (primeiraMsg && pedido.token_publico) {
        texto +=
          `\n\n🔗 Acompanhe em tempo real:\n` +
          `https://frota.ceia.ia.br/rastrear/${pedido.token_publico}`;
      }

      await sendMessage(pedido.customer_phone, texto);
    } catch (err) {
      console.error(`[RASTREAMENTO] erro no pedido ${pedido.id}:`, err.message);
    }
  }

  // Limpa pedidos finalizados do cache
  const ativos = new Set(pedidos.map((p) => p.id));
  for (const id of Object.keys(ultimaDistancia)) {
    if (!ativos.has(parseInt(id))) delete ultimaDistancia[id];
  }
}

// ─── start ────────────────────────────────────────────────────────────────────
function startRastreamento() {
  if (!GOOGLE_KEY) {
    console.warn("[RASTREAMENTO] desabilitado — GOOGLE_MAPS_API_KEY não configurada");
    return;
  }
  console.log("[RASTREAMENTO] job de rastreamento iniciado (intervalo: 90s)");
  setInterval(tick, INTERVALO_MS);
}

module.exports = { startRastreamento };
