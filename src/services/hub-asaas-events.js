/**
 * hub-asaas-events.js
 * Poller primário para confirmação de pagamentos Asaas via Hub WordPress (15s).
 *
 * Fluxo por ciclo:
 *   1. GET /ceia/v1/asaas/events → lista eventos não consumidos do Hub
 *   2. Para cada evento de payment confirmado:
 *      - Busca pedido pelo asaas_payment_id === payment_link
 *      - Se pedido em 'aguardando_pagamento': atualiza → 'preparacao', notifica WA, emite SSE
 *      - Idempotente: skip se pedido já saiu de 'aguardando_pagamento'
 *   3. Ack de todos os event_ids recebidos: POST /ceia/v1/asaas/events/ack
 *   4. Erros por evento não derrubam o ciclo; erro no Hub → retry no próximo tick
 */

const { db, getConfig } = require('../data/db');
const { sendMessage }   = require('../whatsapp/socket');
const { ceiaEmitter }   = require('./ceia-emitter');
const { vitrineFetch }  = require('./ceia-vitrine');

// ── helpers sqlite promise ────────────────────────────────────────────────────
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))
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
let _timer   = null;
let _running = false;

const STATUSES_PAGO = new Set([
  'PAYMENT_RECEIVED',
  'PAYMENT_CONFIRMED',
  'RECEIVED',
  'CONFIRMED',
  'RECEIVED_IN_CASH',
]);

const INTERVAL_MS = 15_000;

// ── processa um único evento ──────────────────────────────────────────────────
async function _processarEvento(evento) {
  const { event_type, payment_link, payment_id, status } = evento;

  // Só processa eventos de pagamento confirmado
  const tipoConfirmado = STATUSES_PAGO.has(event_type) || STATUSES_PAGO.has(status);
  if (!tipoConfirmado) return;

  // O campo payment_link é o id do paymentLink Asaas (asaas_payment_id no DB)
  const linkId = payment_link;
  if (!linkId) {
    console.warn(`[HUB-ASAAS] evento ${evento.event_id} sem payment_link — ignorado`);
    return;
  }

  const pedido = await dbGet(
    `SELECT id, codigo, cliente_whatsapp, status FROM pedidos WHERE asaas_payment_id = ?`,
    [linkId]
  );

  if (!pedido) {
    console.warn(`[HUB-ASAAS] evento ${evento.event_id}: nenhum pedido com asaas_payment_id=${linkId}`);
    return;
  }

  if (pedido.status !== 'aguardando_pagamento') {
    // Idempotente — já foi processado antes
    console.log(`[HUB-ASAAS] pedido #${pedido.codigo} já em status '${pedido.status}' — skip`);
    return;
  }

  // Confirma pagamento
  await dbRun(`UPDATE pedidos SET status = 'preparacao' WHERE id = ?`, [pedido.id]);
  console.log(`[HUB-ASAAS] pedido #${pedido.codigo} link=${linkId} payment=${payment_id} event=${event_type} → PAGO → preparacao`);

  // Notifica cliente via WhatsApp
  if (pedido.cliente_whatsapp) {
    await sendMessage(
      pedido.cliente_whatsapp,
      `✅ Pagamento confirmado! Seu pedido #${pedido.codigo} foi para a cozinha. 🎉`
    ).catch(e => console.warn('[HUB-ASAAS] sendMessage falhou:', e.message));
  }

  // Notifica UI via SSE para kanban atualizar
  ceiaEmitter.emit('ceia:sse', {
    tipo: 'PEDIDO_PAGO',
    data: { id: pedido.id, codigo: pedido.codigo },
  });
}

// ── ciclo principal ───────────────────────────────────────────────────────────
async function _pollCycle() {
  if (_running) return;
  _running = true;
  try {
    // Verifica se Asaas está configurado (sem chave = Hub não tem eventos nossos)
    const key = await getConfig('asaas_key').catch(() => null);
    if (!key) return;

    // 1. Busca eventos pendentes no Hub
    const res = await vitrineFetch('/asaas/events');
    if (!res) return; // timeout ou erro de rede — silencioso
    if (res.status === 404) return; // endpoint não instalado ainda — silencioso
    if (!res.ok) {
      console.warn(`[HUB-ASAAS] GET /asaas/events → HTTP ${res.status}`);
      return;
    }

    const body = await res.json().catch(() => null);
    const eventos = body?.events || [];
    if (!eventos.length) return;

    console.log(`[HUB-ASAAS] ${eventos.length} evento(s) recebido(s) do Hub`);
    console.log('[HUB-ASAAS] recebidos:', eventos.map(e => ({ id: e.event_id ?? e.id ?? e.eventId ?? '???', tipo: e.event ?? e.tipo ?? '?' })));

    // 2. Processa cada evento
    const idsAck = [];
    for (const ev of eventos) {
      try {
        await _processarEvento(ev);
      } catch (e) {
        console.warn(`[HUB-ASAAS] erro ao processar evento ${ev.event_id}:`, e.message);
      } finally {
        // Ack mesmo em caso de erro de processamento (evita loop infinito)
        if (ev.event_id) idsAck.push(ev.event_id);
      }
    }

    // 3. Ack dos eventos processados
    if (idsAck.length) {
      console.log('[HUB-ASAAS] ack enviando ids:', idsAck);
      const ackRes = await vitrineFetch('/asaas/events/ack', {
        method: 'POST',
        body: JSON.stringify({ event_ids: idsAck }),
      });
      console.log('[HUB-ASAAS] ack resposta:', ackRes?.status, ackRes?.ok);
      if (!ackRes || !ackRes.ok) {
        console.warn(`[HUB-ASAAS] ack falhou (HTTP ${ackRes?.status}) — eventos serão reentregues`);
      }
    }
  } catch (e) {
    console.warn('[HUB-ASAAS] erro no ciclo:', e.message);
  } finally {
    _running = false;
  }
}

// ── loop ──────────────────────────────────────────────────────────────────────
function _tick() {
  _timer = setTimeout(async () => {
    await _pollCycle().catch(e => console.error('[HUB-ASAAS] erro inesperado:', e.message));
    _tick();
  }, INTERVAL_MS);
}

// ── API pública ───────────────────────────────────────────────────────────────
function startHubAsaasEvents() {
  if (_timer) return;
  console.log('[HUB-ASAAS] poller primário iniciado (intervalo: 15s)');
  // Primeiro ciclo após 20s (deixa o boot completar)
  setTimeout(async () => {
    await _pollCycle().catch(e => console.error('[HUB-ASAAS] erro no ciclo inicial:', e.message));
    _tick();
  }, 20_000);
}

function stopHubAsaasEvents() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { startHubAsaasEvents, stopHubAsaasEvents };
