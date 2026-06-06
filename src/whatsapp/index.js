/**
 * CEIA OS — Módulo WhatsApp (WA-1: Conexão e gerenciamento de sessão)
 *
 * ══════════════════════════════════════════════════════════════════════
 * PRINCÍPIO ANTI-BAN (CRÍTICO — não remover nem contornar):
 * O sistema NUNCA inicia conversa com um número que não falou primeiro.
 * Só responde. Mensagens de status de pedido são permitidas apenas como
 * continuação de uma conversa que o cliente já iniciou (mesmo número,
 * thread existente). Nunca enviar mensagem fria, em massa, ou marketing.
 * Esta regra protege o número do lojista de banimento pelo WhatsApp.
 * ══════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Constantes ────────────────────────────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, '../../baileys_auth');

// Backoff de reconexão: 3 s, 6 s, 15 s, 30 s (permanece em 30 s)
const RECONNECT_DELAYS = [3000, 6000, 15000, 30000];

// ── Estado interno ────────────────────────────────────────────────────────────
let _status         = 'desconectado'; // desconectado | aguardando_qr | conectando | conectado | erro
let _qrDataUrl      = null;           // base64 PNG do QR Code atual
let _numero         = null;           // ex: "5511999999999"
let _ultimaConexao  = null;           // Date (instante do último connection=open)
let _erroMsg        = null;           // mensagem de erro se _status === 'erro'
let _sock           = null;           // socket Baileys ativo
let _destroyed      = false;          // true após pararWhatsApp() — impede reconexão
let _reconnectIdx   = 0;              // índice atual no array de backoff
let _reconnectTimer = null;           // setTimeout pendente de reconexão
let _msgHandlers    = [];             // callbacks de onMensagemRecebida()
let _lidToPhone     = new Map();      // lid_digits → phone_digits (resolvido via contacts events)
let _sentMsgIds     = new Set();      // IDs de msgs enviadas pelo sistema (anti-eco / camada b)

// ── Logger noop — suprime todo output interno do Baileys ─────────────────────
const _noopLog = {
  level: 'silent',
  fatal: () => {}, error: () => {}, warn: () => {},
  info:  () => {}, debug: () => {}, trace: () => {},
  child: () => _noopLog,
};

// ── Baileys (ESM-only — carregado via import dinâmico) ────────────────────────
let _baileys = null;
async function _loadBaileys() {
  if (_baileys) return _baileys;
  const m = await import('@whiskeysockets/baileys');
  _baileys = {
    makeWASocket:              m.makeWASocket ?? m.default,
    useMultiFileAuthState:     m.useMultiFileAuthState,
    DisconnectReason:          m.DisconnectReason,
    Browsers:                  m.Browsers,
    fetchLatestBaileysVersion: m.fetchLatestBaileysVersion,
    jidNormalizedUser:         m.jidNormalizedUser,
  };
  return _baileys;
}

// ── QRCode ────────────────────────────────────────────────────────────────────
function _getQRCode() {
  // require síncrono — qrcode é CJS, carregado uma vez
  return require('qrcode');
}

// ── Utilitários internos ──────────────────────────────────────────────────────
function _setStatus(status, extra = {}) {
  _status  = status;
  _erroMsg = extra.erro ?? (status !== 'erro' ? null : _erroMsg);
  if ('qr' in extra)     _qrDataUrl = extra.qr;
  if ('numero' in extra) _numero    = extra.numero;
  if (status === 'conectado') _ultimaConexao = new Date();
  // Limpa QR quando não está aguardando
  if (status !== 'aguardando_qr') _qrDataUrl = null;
}

function _limparAuth() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Retorna os últimos 8 dígitos de um número para comparação robusta.
 * Ignora variações de 9º dígito e DDI (+55) em números brasileiros.
 */
function _tail8(n) { return String(n || '').replace(/\D/g, '').slice(-8); }

// ── Conexão Baileys ───────────────────────────────────────────────────────────
async function _conectar() {
  if (_destroyed) return;

  const {
    makeWASocket, useMultiFileAuthState, DisconnectReason,
    Browsers, fetchLatestBaileysVersion, jidNormalizedUser,
  } = await _loadBaileys();

  const QRCode = _getQRCode();

  // Garante diretório de auth
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Fecha socket anterior
  if (_sock) {
    try { _sock.ev.removeAllListeners(); _sock.end(undefined); } catch (_) {}
    _sock = null;
  }

  _setStatus('conectando');
  console.log('[WA] Iniciando conexão com Baileys...');

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const FALLBACK_VERSION = [2, 3000, 1017531287];
  const { version } = await Promise.race([
    fetchLatestBaileysVersion(),
    new Promise(resolve => setTimeout(() => resolve({ version: FALLBACK_VERSION }), 5000)),
  ]);

  _sock = makeWASocket({
    auth:            authState,
    version,
    logger:          _noopLog,
    browser:         Browsers.macOS('Desktop'),
    syncFullHistory: false,
    getMessage:      async () => undefined,
  });

  _sock.ev.on('creds.update', saveCreds);

  // ── contacts.upsert / contacts.update — mapa lid → phone ──────────────────
  // Baileys multi-device pode identificar remetentes por @lid (ID de dispositivo
  // vinculado) em vez de @s.whatsapp.net. Mantemos um mapa para resolvê-los.
  const _mapearContato = (contact) => {
    if (contact.lid && contact.id && contact.id.endsWith('@s.whatsapp.net')) {
      const lid   = contact.lid.split('@')[0];
      const phone = contact.id.split('@')[0].replace(/\D/g, '');
      if (lid && phone) _lidToPhone.set(lid, phone);
    }
  };
  _sock.ev.on('contacts.upsert', (contacts) => contacts.forEach(_mapearContato));
  _sock.ev.on('contacts.update', (updates)  => updates.forEach(_mapearContato));

  // ── connection.update ──
  _sock.ev.on('connection.update', async (update) => {
    if (_destroyed) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        _qrDataUrl = dataUrl;          // preserva o QR antes de _setStatus sobrescrever
        _status    = 'aguardando_qr';
        console.log('[WA] Aguardando QR Code — escaneie no celular.');
      } catch (e) {
        console.error('[WA] Erro ao gerar QR Code:', e.message);
      }
      return;
    }

    if (connection === 'open') {
      _reconnectIdx = 0;
      clearTimeout(_reconnectTimer);
      const jid    = _sock?.user?.id ?? '';
      const numero = jid.split(':')[0].split('@')[0];
      _setStatus('conectado', { numero });
      console.log(`[WA] WhatsApp conectado como ${numero} ✅`);
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLogout   =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401;

      // 440 = connectionReplaced: outra sessão (dispositivo) assumiu este número.
      // NÃO é erro transitório de rede — reconectar imediatamente só perpetua o loop.
      const isReplaced = statusCode === 440;

      console.log(`[WA] Conexão encerrada. código=${statusCode}${isReplaced ? ' (connectionReplaced — outra sessão ativa)' : ''}`);

      if (isLogout) {
        // Logout explícito ou sessão expirada — limpa auth, exige novo QR
        _limparAuth();
        _setStatus('desconectado');
        _numero = null;
        console.log('[WA] Sessão encerrada. Necessário escanear QR novamente.');
      } else if (isReplaced && !_destroyed) {
        // Outra instância conectou com o mesmo número (ex: bug de dupla inicialização).
        // Aguarda 30s antes de tentar: tempo suficiente para o WA liberar a sessão anterior.
        // Se o problema persistir após 3 tentativas seguidas, para de reconectar.
        if (_reconnectIdx >= 3) {
          console.error('[WA] ⚠ Código 440 repetido 3x seguidas — possível conflito de sessão. Parando reconexão automática. Verifique se há outra instância rodando e reconecte manualmente em Configurações → WhatsApp.');
          _setStatus('erro', { erro: 'Código 440 repetido — conflito de sessão detectado. Reconecte manualmente.' });
          return;
        }
        _reconnectIdx++;
        _setStatus('conectando');
        console.warn(`[WA] Aguardando 30s antes de reconectar (440, tentativa ${_reconnectIdx}/3)...`);
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => _conectar().catch(e => {
          console.error('[WA] Falha na reconexão pós-440:', e.message);
          _setStatus('erro', { erro: e.message });
        }), 30_000);
      } else if (!_destroyed) {
        // Queda de rede — reconecta com backoff exponencial
        const delay = RECONNECT_DELAYS[Math.min(_reconnectIdx, RECONNECT_DELAYS.length - 1)];
        _reconnectIdx++;
        _setStatus('conectando');
        console.log(`[WA] Reconectando em ${delay / 1000}s... (tentativa ${_reconnectIdx})`);
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => _conectar().catch(e => {
          console.error('[WA] Falha na reconexão:', e.message);
          _setStatus('erro', { erro: e.message });
        }), delay);
      }
    }
  });

  // ── messages.upsert ──
  _sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Log bruto (diagnóstico): confirma que o evento está chegando ao handler
    console.log(`[WA] messages.upsert type="${type}" count=${messages?.length ?? 0}`);

    // ── CAMADA C: só mensagens novas reais ─────────────────────────────────
    // 'append' = sincronização de histórico (inclui msgs antigas / próprias).
    // 'notify' = mensagem nova chegando agora — única que nos interessa.
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg?.message) return;

    const jidOriginal = msg.key.remoteJid;

    // ── CAMADA D: só conversas individuais ────────────────────────────────
    if (!jidOriginal ||
        jidOriginal.endsWith('@g.us')        ||
        jidOriginal.endsWith('@broadcast')   ||
        jidOriginal.endsWith('@newsletter')  ||
        jidOriginal === 'status@broadcast') return;

    // ── CAMADA C (primária): flag fromMe do Baileys ───────────────────────
    if (msg.key.fromMe) return;

    // ── CAMADA B: eco por key.id — msg que o próprio sistema acabou de enviar
    const msgId = msg.key.id;
    if (msgId && _sentMsgIds.has(msgId)) {
      _sentMsgIds.delete(msgId);
      console.log(`[WA] IGNORADA (eco mensagem enviada, id=${msgId})`);
      return;
    }

    // ── Resolução de JID (@lid → número real) ──────────────────────────────
    // WhatsApp multi-device pode mandar @lid (ID de dispositivo vinculado)
    // em vez do JID real @s.whatsapp.net. Portado do Frota CEIA (baileys.ts).
    let numero;
    if (jidOriginal.endsWith('@lid')) {
      const jidAlt      = msg.key.remoteJidAlt;
      const participant = msg.participant;
      const candidato   = (jidAlt      && !jidAlt.includes('@lid'))      ? jidAlt
                        : (participant && !participant.includes('@lid'))  ? participant
                        : null;

      if (candidato) {
        numero = candidato.split('@')[0].replace(/\D/g, '');
      } else {
        const lidKey   = jidOriginal.split('@')[0];
        const resolved = _lidToPhone.get(lidKey);
        if (!resolved) {
          console.warn(`[WA] @lid não resolvido: ${jidOriginal} — mensagem ignorada.`);
          return;
        }
        numero = resolved;
      }
    } else {
      // JID normal @s.whatsapp.net
      numero = jidNormalizedUser(jidOriginal).split('@')[0].replace(/\D/g, '');
    }

    if (!numero) {
      console.warn(`[WA] Número não resolvido (jid=${jidOriginal}) — mensagem ignorada.`);
      return;
    }

    // ── CAMADA A: compara remetente com o número da própria sessão ────────
    // Baileys multi-device às vezes entrega ecos da sessão com fromMe=false.
    // Se o número resolvido == número da conta conectada → própria mensagem.
    if (_numero && _tail8(numero) === _tail8(_numero)) {
      console.log(`[WA] IGNORADA (própria mensagem / eco do número ${numero})`);
      return;
    }

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    console.log(`[WA] sender normalizado: ${numero} | texto: ${texto || '(mídia)'} | fromMe: false`);

    // Dispara handlers registrados (gancho para WA-2 — agente de IA)
    for (const handler of _msgHandlers) {
      try {
        await handler({ jid: jidOriginal, numero, texto, msg, sock: _sock });
      } catch (e) {
        console.error('[WA] Erro em handler de mensagem:', e.message);
      }
    }
  });
}

// ── API Pública ───────────────────────────────────────────────────────────────

/**
 * Inicia a conexão WhatsApp.
 * Se houver sessão salva em baileys_auth/, reconecta sem pedir QR.
 */
async function iniciarWhatsApp() {
  _destroyed    = false;
  _reconnectIdx = 0;
  await _conectar();
}

/**
 * Encerra a conexão e faz logout completo (limpa sessão persistida).
 * Após isso, um novo QR será necessário para reconectar.
 */
async function pararWhatsApp() {
  _destroyed = true;
  clearTimeout(_reconnectTimer);

  if (_sock) {
    try { await _sock.logout(); } catch (_) {}
    try { _sock.ev.removeAllListeners(); _sock.end(undefined); } catch (_) {}
    _sock = null;
  }

  _limparAuth();
  _setStatus('desconectado');
  _numero = null;
  console.log('[WA] WhatsApp desconectado. Sessão removida.');
}

/**
 * Retorna o estado atual da conexão.
 * @returns {{ status, qr, numero, ultimaConexao, erro }}
 */
function getStatusWhatsApp() {
  return {
    status:        _status,
    qr:            _qrDataUrl,
    numero:        _numero,
    ultimaConexao: _ultimaConexao?.toISOString() ?? null,
    erro:          _erroMsg,
  };
}

/**
 * Envia uma mensagem WhatsApp.
 *
 * ⚠ ATENÇÃO — PRINCÍPIO ANTI-BAN:
 * Só chame este método como RESPOSTA a uma mensagem que o cliente já enviou.
 * O caller é responsável por garantir que o número está em uma thread ativa.
 * Nunca use para envio proativo, cold messaging, ou notificações em massa.
 *
 * @param {string} numero  Número do destinatário (dígitos, com ou sem DDI)
 * @param {string} texto   Texto da mensagem
 */
async function enviarMensagemWhatsApp(numero, texto) {
  if (!_sock || _status !== 'conectado') {
    console.warn('[WA] Tentativa de envio com WhatsApp desconectado.');
    return { sent: false, reason: 'whatsapp_desconectado' };
  }
  try {
    const digits  = String(numero).replace(/\D/g, '');
    const jid     = digits.includes('@') ? digits : `${digits}@s.whatsapp.net`;
    const sentMsg = await _sock.sendMessage(jid, { text: texto });

    // ── Registra o key.id para bloquear o eco (camada B) ─────────────────
    if (sentMsg?.key?.id) {
      // Cap de 200 entradas para evitar crescimento sem limite
      if (_sentMsgIds.size > 200) _sentMsgIds.clear();
      _sentMsgIds.add(sentMsg.key.id);
    }

    return { sent: true };
  } catch (e) {
    console.error('[WA] Erro ao enviar mensagem:', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * Registra um callback chamado para cada mensagem recebida.
 * Assinatura: async callback({ jid, numero, texto, msg, sock })
 *
 * Usado pelo agente de IA (WA-2) para processar conversas com clientes.
 */
function onMensagemRecebida(callback) {
  _msgHandlers.push(callback);
}

/** Remove todos os handlers registrados (utilitário para testes). */
function removerHandlers() {
  _msgHandlers = [];
}

module.exports = {
  iniciarWhatsApp,
  pararWhatsApp,
  getStatusWhatsApp,
  enviarMensagemWhatsApp,
  onMensagemRecebida,
  removerHandlers,
};
