/**
 * asaas-poller.js
 * Backstop de reconciliação Asaas (a cada 5 min).
 * O caminho primário é hub-asaas-events.js (polling do Hub a cada 15s via webhook relay).
 * Este poller é segurança extra caso o Hub esteja fora ou o webhook falhe.
 *
 * Fluxo:
 *   1. Busca pedidos com status='aguardando_pagamento' + asaas_payment_id IS NOT NULL
 *   2. Para cada pedido, consulta Asaas via GET /payments?limit=100&offset=0
 *      e filtra client-side por p.paymentLink === linkId (strict)
 *   3. Se RECEIVED, CONFIRMED ou RECEIVED_IN_CASH → 'preparacao' + notificação WhatsApp
 *   4. Se OVERDUE ou REFUNDED → loga sem ação automática (evita falso cancelamento)
 *   5. Erros por pedido não derrubam o ciclo; 429 → backoff exponencial
 */

const { db, getConfig } = require('../data/db');
const { sendMessage }   = require('../whatsapp/socket');
const { ceiaEmitter }   = require('./ceia-emitter');

// ── helpers sqlite promise ────────────────────────────────────────────────────
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    })
  );
}

// ── estado interno ────────────────────────────────────────────────────────────
let _timer    = null;
let _running  = false;
let _backoffMs = 0;

const STATUSES_PAGO     = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
const STATUSES_CANCELADO = new Set(['OVERDUE', 'REFUNDED', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE']);
const INTERVAL_MS = 300_000; // 5 min — backstop; caminho primário é hub-asaas-events.js

// ── lógica de URL ─────────────────────────────────────────────────────────────
// Detecta ambiente pelo prefixo da chave (fonte da verdade), sem depender de config separada.
function asaasBaseUrl(chave) {
  return (chave && chave.startsWith('$aact_prod_'))
    ? 'https://api.asaas.com/v3'
    : 'https://sandbox.asaas.com/api/v3';
}

// ── verifica um pedido ────────────────────────────────────────────────────────
// Todos os pedidos online usam paymentLink. O id salvo é o id do LINK.
// Endpoint: GET /payments?limit=100&offset=0 — retorna todos os payments da conta.
// Filtro client-side STRICT: p.paymentLink === linkId (sem || !p.paymentLink)
// para garantir que nunca haja falso positivo entre payments de links diferentes.
async function _verificarPedido(pedido, baseUrl, key) {
  const linkId = pedido.asaas_payment_id;

  const resp = await fetch(
    `${baseUrl}/payments?limit=100&offset=0`,
    { headers: { 'access_token': key }, signal: AbortSignal.timeout(8_000) }
  );
  if (resp.status === 429) throw Object.assign(new Error('rate-limit'), { status: 429 });
  if (!resp.ok) {
    console.warn(`[ASAAS-POLLER] pedido #${pedido.codigo} link=${linkId} → HTTP ${resp.status}`);
    return;
  }

  const data = await resp.json().catch(() => null);
  const todosPayments = data?.data || [];

  // Filtro estrito: apenas payments vinculados exatamente a este link
  const payments = todosPayments.filter(p => p.paymentLink === linkId);

  if (!payments.length) {
    console.log(`[ASAAS-POLLER] pedido #${pedido.codigo} link=${linkId} → payments vinculados: 0 → aguardando`);
    return;
  }

  const pagoPay     = payments.find(p => STATUSES_PAGO.has(p.status));
  const canceladoPay = !pagoPay && payments.find(p => STATUSES_CANCELADO.has(p.status));

  if (pagoPay) {
    await dbRun(`UPDATE pedidos SET status = 'preparacao' WHERE id = ?`, [pedido.id]);
    console.log(`[ASAAS-POLLER] pedido #${pedido.codigo} link=${linkId} → payment ${pagoPay.id} status=${pagoPay.status} → PAGO → preparacao`);

    // Notifica cliente via WhatsApp
    if (pedido.cliente_whatsapp) {
      await sendMessage(
        pedido.cliente_whatsapp,
        `✅ Pagamento confirmado! Seu pedido #${pedido.codigo} foi para a cozinha. 🎉`
      ).catch(e => console.warn('[ASAAS-POLLER] sendMessage falhou:', e.message));
    }

    // Notifica UI via SSE para o kanban atualizar
    ceiaEmitter.emit('ceia:sse', {
      tipo: 'PEDIDO_PAGO',
      data: { id: pedido.id, codigo: pedido.codigo },
    });
  } else if (canceladoPay) {
    if (canceladoPay.status === 'REFUNDED') {
      // REFUNDED com filtro estrito por link → sem risco de falso positivo → cancela
      await dbRun(`UPDATE pedidos SET status = 'cancelado' WHERE id = ?`, [pedido.id]);
      console.log(`[ASAAS-POLLER] pedido #${pedido.codigo} link=${linkId} → payment ${canceladoPay.id} REFUNDED → cancelado`);
      ceiaEmitter.emit('ceia:sse', {
        tipo: 'PEDIDO_CANCELADO',
        data: { id: pedido.id, codigo: pedido.codigo },
      });
    } else {
      // OVERDUE, CHARGEBACK, etc. — pode ser temporário, só loga
      console.warn(`[ASAAS-POLLER] pedido #${pedido.codigo} link=${linkId} → payment ${canceladoPay.id} ${canceladoPay.status} (sem ação automática)`);
    }
  } else {
    // Payments em status intermediário (PENDING, AWAITING_RISK_ANALYSIS, etc.)
    const statusVisto = payments.map(p => `${p.id}:${p.status}`).join(', ');
    console.log(`[ASAAS-POLLER] pedido #${pedido.codigo} link=${linkId} → ${payments.length} payment(s) em andamento (${statusVisto})`);
  }
}

// ── ciclo principal ───────────────────────────────────────────────────────────
async function _pollCycle() {
  if (_running) return;
  _running = true;
  try {
    const key = await getConfig('asaas_key').catch(() => null);
    if (!key) return; // Asaas não configurado — silencioso

    const baseUrl = asaasBaseUrl(key);

    const pedidos = await dbAll(
      `SELECT id, codigo, cliente_whatsapp, asaas_payment_id FROM pedidos
       WHERE status = 'aguardando_pagamento' AND asaas_payment_id IS NOT NULL`
    );

    if (!pedidos.length) return;
    console.log(`[ASAAS-POLLER] verificando ${pedidos.length} pedido(s) aguardando...`);

    for (const pedido of pedidos) {
      try {
        await _verificarPedido(pedido, baseUrl, key);
      } catch (e) {
        if (e.status === 429) {
          _backoffMs = Math.min((_backoffMs || 30_000) * 2, 300_000);
          console.warn(`[ASAAS-POLLER] rate limit (429) — backoff ${_backoffMs / 1000}s`);
          return; // para o ciclo, backoff aplicado no próximo tick
        }
        console.warn(`[ASAAS-POLLER] erro ao verificar pedido #${pedido.codigo}:`, e.message);
      }
    }

    _backoffMs = 0; // reset após ciclo bem-sucedido
  } finally {
    _running = false;
  }
}

// ── loop com setInterval + backoff ────────────────────────────────────────────
function _tick() {
  const delay = _backoffMs > 0 ? _backoffMs : INTERVAL_MS;
  _timer = setTimeout(async () => {
    await _pollCycle().catch(e => console.error('[ASAAS-POLLER] erro no ciclo:', e.message));
    _tick();
  }, delay);
}

// ── API pública ───────────────────────────────────────────────────────────────
function startAsaasPoller() {
  if (_timer) return; // já rodando
  console.log('[ASAAS-POLLER] backstop iniciado (intervalo: 5min — caminho primário: hub-asaas-events)');
  // Primeiro ciclo após 15s para dar tempo ao boot
  setTimeout(async () => {
    await _pollCycle().catch(e => console.error('[ASAAS-POLLER] erro no ciclo inicial:', e.message));
    _tick();
  }, 15_000);
}

function stopAsaasPoller() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { startAsaasPoller, stopAsaasPoller };
