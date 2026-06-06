/**
 * asaas.js
 * Bootstrapping da integração Asaas: garante que o webhook está registrado
 * no Asaas apontando para o Hub WordPress (relay), e registra o nó no Hub.
 *
 * Chamado uma vez no boot do servidor (try/catch — falha nunca derruba o app).
 *
 * Fluxo:
 *   1. Lê asaas_key do DB — se ausente, no-op silencioso
 *   2. Gera/persiste asaas_webhook_secret (gerado uma vez, salvo no DB)
 *   3. Registra/atualiza o nó no Hub: POST /ceia/v1/asaas/register-node
 *   4. Verifica webhooks Asaas existentes via GET /webhooks?limit=100
 *      - Se já existe webhook correto → ok
 *      - Se existe com URL/events errados → PUT para corrigir
 *      - Se não existe → POST para criar
 */

const crypto  = require('crypto');
const { getConfig, setConfig } = require('../data/db');
const { vitrineFetch } = require('./ceia-vitrine');

const CEIA_API_URL = process.env.CEIA_API_URL || 'https://ceia.ia.br/wp-json/ceia/v1';
const CEIA_NODE_TOKEN = () => process.env.CEIA_NODE_TOKEN || '';

const WEBHOOK_EVENTS = [
  'PAYMENT_RECEIVED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_OVERDUE',
  'PAYMENT_REFUNDED',
];

function asaasBaseUrl(chave) {
  return (chave && chave.startsWith('$aact_prod_'))
    ? 'https://api.asaas.com/v3'
    : 'https://sandbox.asaas.com/api/v3';
}

async function _asaasFetch(baseUrl, path, key, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: {
      'access_token': key,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  return res;
}

async function ensureAsaasWebhook() {
  // 1. Verifica chave configurada
  const key = await getConfig('asaas_key').catch(() => null);
  if (!key) return; // Asaas não configurado — no-op silencioso

  const baseUrl = asaasBaseUrl(key);

  // 2. Gera/persiste webhook_secret
  let webhookSecret = await getConfig('asaas_webhook_secret').catch(() => null);
  if (!webhookSecret) {
    webhookSecret = crypto.randomBytes(24).toString('hex');
    await setConfig('asaas_webhook_secret', webhookSecret);
    console.log('[ASAAS] webhook_secret gerado e salvo.');
  }

  // 3. Registra nó no Hub
  const nodeToken = CEIA_NODE_TOKEN();
  if (nodeToken) {
    try {
      const hubRes = await vitrineFetch('/asaas/register-node', {
        method: 'POST',
        body: JSON.stringify({ webhook_secret: webhookSecret }),
      });
      if (hubRes && hubRes.ok) {
        console.log('[ASAAS] nó registrado no Hub com sucesso.');
      } else {
        const status = hubRes ? hubRes.status : 'sem resposta';
        console.warn(`[ASAAS] falha ao registrar nó no Hub (HTTP ${status}) — prosseguindo.`);
      }
    } catch (e) {
      console.warn('[ASAAS] erro ao registrar nó no Hub:', e.message, '— prosseguindo.');
    }
  } else {
    console.warn('[ASAAS] CEIA_NODE_TOKEN não configurado — nó não registrado no Hub.');
  }

  // 4. Garante webhook no Asaas
  const webhookUrl = `${CEIA_API_URL}/asaas/webhook?node=${encodeURIComponent(nodeToken)}`;
  const wantedEvents = WEBHOOK_EVENTS.slice().sort().join(',');

  try {
    const listRes = await _asaasFetch(baseUrl, '/webhooks?limit=100', key);
    if (!listRes.ok) {
      console.warn(`[ASAAS] não foi possível listar webhooks (HTTP ${listRes.status})`);
      return;
    }
    const listData = await listRes.json().catch(() => ({ data: [] }));
    const webhooks = listData?.data || [];

    // Procura webhook do CEIA (por URL contendo /ceia/v1/asaas/webhook)
    const existing = webhooks.find(w => w.url && w.url.includes('/ceia/v1/asaas/webhook'));

    const eventsMatch = (w) => {
      const wEvents = (w.events || []).slice().sort().join(',');
      return wEvents === wantedEvents;
    };

    // Email de contato do webhook (best-effort; fallback genérico)
    const lojaEmail = await getConfig('email').catch(() => null) || 'webhook@ceia.ia.br';

    // Corpo canônico do webhook — todos os campos obrigatórios da API Asaas v3
    const webhookBody = {
      name:         'CEIA OS',
      url:          webhookUrl,
      email:        lojaEmail,
      enabled:      true,
      interrupted:  false,
      apiVersion:   3,
      authToken:    webhookSecret,
      sendType:     'SEQUENTIALLY',
      events:       WEBHOOK_EVENTS,
    };

    if (existing) {
      const urlMatch   = existing.url === webhookUrl;
      const evOk       = eventsMatch(existing);
      const enabledOk  = existing.enabled !== false;

      if (urlMatch && evOk && enabledOk) {
        console.log(`[ASAAS-WEBHOOK] já configurado corretamente (id=${existing.id})`);
        return;
      }

      // Corrige via PUT
      const putBody = JSON.stringify(webhookBody);
      const putRes  = await _asaasFetch(baseUrl, `/webhooks/${existing.id}`, key, {
        method: 'PUT',
        body:   putBody,
      });
      if (putRes.ok) {
        console.log(`[ASAAS-WEBHOOK] atualizado (id=${existing.id})`);
      } else {
        const errData = await putRes.json().catch(() => ({}));
        console.error('[ASAAS-WEBHOOK] body enviado:', putBody);
        console.error('[ASAAS-WEBHOOK] resposta:', putRes.status, JSON.stringify(errData));
      }
    } else {
      // Cria novo
      const postBody = JSON.stringify(webhookBody);
      const postRes  = await _asaasFetch(baseUrl, '/webhooks', key, {
        method: 'POST',
        body:   postBody,
      });
      if (postRes.ok) {
        const created = await postRes.json().catch(() => ({}));
        console.log(`[ASAAS-WEBHOOK] garantido id=${created.id} url=${webhookUrl}`);
      } else {
        const errData = await postRes.json().catch(() => ({}));
        console.error('[ASAAS-WEBHOOK] body enviado:', postBody);
        console.error('[ASAAS-WEBHOOK] resposta:', postRes.status, JSON.stringify(errData));
      }
    }
  } catch (e) {
    console.warn('[ASAAS] erro ao garantir webhook:', e.message);
  }
}

module.exports = { ensureAsaasWebhook };
