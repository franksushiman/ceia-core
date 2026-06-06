/**
 * asaas-webhook.js
 * Recebe notificações de pagamento enviadas pelo Frota Hub via /node/poll
 * (tipo: "asaas_webhook") e atualiza o pedido local.
 *
 * No painel Asaas de cada lojista, configure o webhook para:
 *   POST https://frota.ceia.ia.br/wp-json/frota/v1/asaas/webhook/{loja_id}
 *
 * O Frota Hub enfileira o payload no outbox da loja como:
 *   { tipo: "asaas_webhook", payload: <objeto do Asaas> }
 *
 * O ceia-poller (Prompts anteriores) despacha para este handler.
 */

const { db } = require("../data/db");
const { sendMessage } = require("../whatsapp/socket");

// Eventos do Asaas que indicam pagamento confirmado
const EVENTOS_PAGAMENTO_CONFIRMADO = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
]);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    })
  );
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

/**
 * Chamado pelo startCeiaPoller quando chega uma mensagem do tipo "asaas_webhook".
 * @param {object} msg  A mensagem do outbox: { _id, tipo, payload }
 */
async function handleAsaasWebhook(msg) {
  const payload = msg.payload;
  if (!payload) {
    console.warn("[ASAAS] webhook sem payload:", msg._id);
    return;
  }

  const evento = payload.event;
  const payment = payload.payment;

  if (!EVENTOS_PAGAMENTO_CONFIRMADO.has(evento)) {
    // Outros eventos (boleto gerado, vencido, etc.) — ignoramos
    console.log(`[ASAAS] evento ignorado: ${evento}`);
    return;
  }

  const paymentId   = payment?.id || null;
  const externalRef = payment?.externalReference;

  // ── Tenta primeiro pela tabela `pedidos` (via asaas_payment_id) ───────────
  if (paymentId) {
    const pedido = await dbGet("SELECT * FROM pedidos WHERE asaas_payment_id = ?", [paymentId]);
    if (pedido) {
      if (pedido.status === 'preparacao') {
        console.log(`[ASAAS] pedido #${pedido.codigo} (id=${pedido.id}) já em preparação`);
      } else if (pedido.status !== 'aguardando_pagamento') {
        console.log(`[ASAAS] pedido #${pedido.codigo} status=${pedido.status} — ignorando`);
      } else {
        await dbRun("UPDATE pedidos SET status = 'preparacao' WHERE id = ?", [pedido.id]);
        console.log(`[ASAAS] pedido #${pedido.codigo} aprovado → preparacao`);
        if (pedido.cliente_whatsapp) {
          await sendMessage(
            pedido.cliente_whatsapp,
            "✅ Pagamento confirmado! Já estamos preparando seu pedido. 🎉"
          ).catch(e => console.warn('[ASAAS] sendMessage falhou:', e.message));
        }
      }
      return;
    }
  }

  // ── Fallback: tabela legada `orders` via externalReference ───────────────
  if (!externalRef) {
    console.warn("[ASAAS] payment sem externalReference e sem match em pedidos");
    return;
  }

  const orderId = parseInt(externalRef, 10);
  const order = await dbGet("SELECT * FROM orders WHERE id = ?", [orderId]);

  if (!order) {
    console.warn(`[ASAAS] pedido ${orderId} não encontrado em nenhuma tabela`);
    return;
  }

  if (order.status === "PAID") {
    console.log(`[ASAAS] pedido ${orderId} já estava marcado como pago`);
    return;
  }

  // Atualiza status
  await dbRun("UPDATE orders SET status = 'PAID' WHERE id = ?", [orderId]);
  console.log(`[ASAAS] pedido ${orderId} marcado como PAID`);

  // Notifica cliente no WhatsApp
  if (order.customer_phone) {
    await sendMessage(
      order.customer_phone,
      "✅ Pagamento recebido! Já estamos preparando seu pedido. 🍣"
    ).catch(e => console.warn('[ASAAS] sendMessage falhou:', e.message));
  }
}

module.exports = { handleAsaasWebhook };
