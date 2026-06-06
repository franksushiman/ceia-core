'use strict';
/**
 * src/bot/telegram.js
 * Bot Telegram do CEIA OS — Fase Bot-2
 * Implementado nesta fase: bootstrap, cadastro, GPS, comandos básicos.
 *
 * PENDENTE (fases futuras):
 *   Bot-3: aceite/recusa de rota, baixa de entrega, financeiro, chat com cliente
 *   Bot-Nuvem: integração Hub P2P (frota.ceia.ia.br) — AGUARDA revisão de segurança
 *              (endpoint /repassar-convite é público sem auth — ver PLANO-MIGRACAO-BOT.md §7.6)
 */

const { Telegraf, Markup } = require('telegraf');
const db = require('../data/db');
const { ceiaEmitter } = require('../services/ceia-emitter');
const { marcarAvaliacaoPendente } = require('../whatsapp/agente');

// ─── Estado do módulo ──────────────────────────────────────────────────────────

/**
 * Sessões de entrevista em memória.
 * telegram_id (string) → { etapa: string, dados: Object }
 * Etapas: NOME → WHATSAPP → VINCULO → PIX → VEICULO
 */
const sessoes = new Map();

let _bot       = null;   // instância Telegraf ativa
let _username  = null;   // @username do bot (cacheado no boot)
let _online    = false;  // bot conectado e respondendo
let _radarTimer = null;  // setInterval do cron de inatividade

// ── Throttle de GPS ────────────────────────────────────────────────────────────
// Limita escritas no SQLite a 1 vez a cada GPS_THROTTLE_MS por motoboy.
// A última posição recebida é sempre mantida em memória e nunca descartada:
// o timer deferred escreve entry.lat/lng no momento em que dispara, não no
// momento em que foi agendado.
const GPS_THROTTLE_MS = 20_000; // 20 segundos por motoboy
const _gpsThrottle = new Map(); // chatId → { lat, lng, timer, lastWrite }

/**
 * Persiste a posição GPS e marca o motoboy como ONLINE no SQLite,
 * respeitando o throttle de GPS_THROTTLE_MS por chatId.
 *
 * Comportamento:
 *  - Se lastWrite === 0 (primeira vez) ou já passou GPS_THROTTLE_MS → escreve agora.
 *  - Se ainda dentro do throttle e sem timer agendado → agenda write para o fim do
 *    período, usando a posição mais recente disponível no momento do disparo.
 *  - Ticks intermediários só atualizam lat/lng em memória.
 */
function _throttleGps(chatId, lat, lng) {
  const now = Date.now();
  let entry = _gpsThrottle.get(chatId);
  if (!entry) {
    entry = { lat, lng, timer: null, lastWrite: 0 };
    _gpsThrottle.set(chatId, entry);
  }

  // Sempre mantém a posição mais recente em memória
  entry.lat = lat;
  entry.lng = lng;

  // Se já há timer pendente, ele vai usar entry.lat/lng atualizado — nada a fazer
  if (entry.timer) return;

  const elapsed = now - entry.lastWrite;

  if (elapsed >= GPS_THROTTLE_MS) {
    // Primeira vez, ou throttle já expirou (ex.: motoboy voltou após pausa) → write imediato
    entry.lastWrite = now;
    db.atualizarCamposMotoboyByTelegramId(chatId, { lat: entry.lat, lng: entry.lng })
      .then(() => db.setStatusOperacional(chatId, 'ONLINE'))
      .catch(e => console.error('[MOTOBOY] Erro ao persistir GPS:', e.message));
  } else {
    // Dentro da janela de throttle → agenda write deferred com posição mais recente
    entry.timer = setTimeout(() => {
      const e = _gpsThrottle.get(chatId);
      if (!e) return;
      e.timer = null;
      e.lastWrite = Date.now();
      db.atualizarCamposMotoboyByTelegramId(chatId, { lat: e.lat, lng: e.lng })
        .then(() => db.setStatusOperacional(chatId, 'ONLINE'))
        .catch(err => console.error('[MOTOBOY] Erro ao persistir GPS (deferred):', err.message));
    }, GPS_THROTTLE_MS - elapsed);
  }
}

// ─── Teclado padrão (pós-cadastro) ───────────────────────────────────────────

const tecladoPrincipal = Markup.keyboard([
  ['🆘 Pedir Ajuda (SOS)', '💬 Falar com Cliente'],
]).resize();

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Verifica se o telegram_id está cadastrado na frota.
 * Retorna o motoboy ou null (e já responde ao usuário em caso negativo).
 */
async function checarCadastro(telegram_id, ctx) {
  const m = await db.getMotoboyByTelegramId(telegram_id);
  if (!m) {
    try {
      await ctx.reply('⚠️ Acesso negado. Use o link de convite do restaurante para se cadastrar.');
    } catch (_) {}
    return null;
  }
  return m;
}

/**
 * Salva um campo da entrevista e avança para a próxima etapa.
 * Persiste parcialmente no banco a cada etapa (igual ao bot original).
 */
async function avancarEntrevista(chatId, campo, valor, proximaEtapa) {
  const s = sessoes.get(chatId);
  if (!s) return;
  s.dados[campo] = valor;
  if (proximaEtapa) s.etapa = proximaEtapa;
  sessoes.set(chatId, s);
  await db.upsertMotoboyByTelegramId({ telegram_id: chatId, ...s.dados })
    .catch(e => console.error('[BOT] Erro ao persistir campo', campo, ':', e.message));
}

// ─── Bot-4: funções utilitárias de sessão ─────────────────────────────────────

/**
 * Envia uma mensagem via Telegram para qualquer chat_id (sem depender de polling ativo).
 * Usado por server.js para endpoints SOS/reply e chat-motoboy.
 */
async function enviarMensagemBot(telegram_id, texto) {
  if (!_bot) {
    console.warn('[BOT] enviarMensagemBot: bot não inicializado');
    return { sent: false, reason: 'bot_offline' };
  }
  try {
    await _bot.telegram.sendMessage(telegram_id, texto, { parse_mode: 'Markdown' });
    return { sent: true };
  } catch (e) {
    console.error('[BOT] enviarMensagemBot erro:', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * Encerra uma sessão SOS/CHAT_CLIENTE pelo lado do operador (via API).
 * Remove do Map em-memória E do banco.
 */
async function encerrarSessaoBot(telegram_id) {
  sessoes.delete(telegram_id);
  await db.encerrarChatSessao(telegram_id).catch(e => console.error('[TELEGRAM] falha em encerrarChatSessao:', e.message));
}

// ─── Bot-3: envio de rota para motoboy ────────────────────────────────────────

/**
 * Envia a rota (pacote despachado) para o motoboy via Telegram.
 * @param {string} telegram_id
 * @param {{ pacote_id: number, pedidos: Array, motoboy_nome: string }} pacote
 */
async function enviarRotaParaMotoboy(telegram_id, pacote) {
  // Verifica apenas _bot (instância), NÃO _online — enviar mensagens funciona mesmo
  // quando o polling falhou com 409 (outro processo recebendo updates).
  if (!_bot) {
    console.warn('[BOT] Bot não inicializado — não foi possível enviar rota para', telegram_id);
    return { sent: false, reason: 'bot_offline' };
  }
  try {
    const total = pacote.pedidos.reduce((s, p) => s + (+(p.taxa_entrega || 0)), 0);
    const linhas = pacote.pedidos.map((p, i) => {
      const itensResumo = (() => {
        try {
          const arr = typeof p.itens === 'string' ? JSON.parse(p.itens) : (p.itens || []);
          return arr.slice(0, 3).map(it => `  • ${it.quantidade || 1}x ${it.nome || it.produto_nome || '?'}`).join('\n');
        } catch (_) { return ''; }
      })();
      // O código NÃO vai para o motoboy — só o cliente recebe (via WhatsApp ao aceitar a rota).
      // O motoboy digita o código que o cliente informa na entrega — prova de entrega.
      const endExibido = p.endereco_formatado || p.endereco || '—';
      const mapaLink   = (p.lat && p.lng) ? `🗺 [Abrir no mapa](https://www.google.com/maps?q=${p.lat},${p.lng})` : null;

      // Alerta de pagamento conforme forma
      let alertaPag = null;
      const fp = (p.forma_pagamento || '').toLowerCase();
      if (fp === 'dinheiro') {
        if (p.troco_para != null) {
          const trocoVal = Number(p.troco_para).toFixed(2).replace('.', ',');
          alertaPag = `⚠️ *LEVAR TROCO PARA R$ ${trocoVal}*`;
        } else {
          alertaPag = `💵 Dinheiro (sem troco)`;
        }
      } else if (fp === 'cartao_offline') {
        const band = p.bandeira_cartao ? ` (${p.bandeira_cartao.charAt(0).toUpperCase() + p.bandeira_cartao.slice(1)})` : '';
        alertaPag = `⚠️ *LEVAR MAQUININHA*${band}`;
      } else if (fp === 'cartao_online' || fp === 'pix' || p.asaas_payment_id) {
        alertaPag = `✅ Já pago online`;
      }

      return [
        `*${i + 1}. ${p.cliente_nome || 'Cliente'}*`,
        `📍 ${endExibido}${p.bairro ? ` — ${p.bairro}` : ''}`,
        mapaLink,
        itensResumo ? itensResumo : null,
        alertaPag,
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const msg = [
      '🛵 *Nova rota disponível!*',
      '',
      linhas,
      '',
      `💰 Taxa total: *R$ ${total.toFixed(2).replace('.', ',')}*`,
    ].join('\n');

    await _bot.telegram.sendMessage(telegram_id, msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Aceitar rota', `aceitar_${pacote.pacote_id}`),
        Markup.button.callback('❌ Recusar',      `recusar_${pacote.pacote_id}`),
      ]),
    });

    console.log(`[BOT] Rota enviada para ${telegram_id} — pacote ${pacote.pacote_id} (${pacote.pedidos.length} pedido(s))`);
    return { sent: true };
  } catch (e) {
    console.error(`[BOT] Falha ao enviar rota para ${telegram_id}:`, e.message);
    return { sent: false, reason: e.message };
  }
}

// ─── Registro de handlers ─────────────────────────────────────────────────────

function registrarHandlers(bot) {

  // ── /start ───────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const chatId  = ctx.chat.id.toString();
    const payload = ctx.startPayload || '';

    // Fluxo Nuvem — stub (pendente revisão de segurança, ver §7.6 do plano)
    if (payload.startsWith('nuvem_')) {
      const pacoteId = payload.replace('nuvem_', '');
      console.log(`[BOT] Fluxo Nuvem recebido — pacote ${pacoteId} — ainda não implementado`);
      await ctx.reply('⏳ Recurso em configuração. Entre em contato com o restaurante.');
      return;
    }

    // /start com token de convite
    if (payload) {
      const valido = await db.validarEUsarToken(payload);
      if (!valido) {
        await ctx.reply(
          '⚠️ Link inválido ou já utilizado.\n\nSolicite um novo convite ao restaurante.',
          Markup.removeKeyboard()
        );
        return;
      }
      sessoes.set(chatId, { etapa: 'NOME', dados: {} });
      await ctx.reply(
        'Olá! Bem-vindo à frota! 🛵💨\n\nVamos iniciar seu cadastro.\nPor favor, digite seu *Nome Completo*:',
        { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
      );
      return;
    }

    // /start sem payload — motoboy já cadastrado ou não
    const m = await db.getMotoboyByTelegramId(chatId);
    if (m) {
      const estado = m.operacional_status || 'OFFLINE';
      const icone  = estado === 'ONLINE' ? '🟢' : estado === 'EM_ROTA' ? '🔵' : '🔴';
      await ctx.reply(
        `Olá, *${m.nome.split(' ')[0]}*! Você já faz parte da frota.\n\nStatus: ${icone} *${estado}*\n\nCompartilhe sua *Localização em Tempo Real* para entrar no radar, ou use /offline para encerrar o expediente.`,
        { parse_mode: 'Markdown', ...tecladoPrincipal }
      );
    } else {
      await ctx.reply(
        '⚠️ Você não está cadastrado nesta frota.\n\nLeia o *QR Code* exibido no painel da loja para receber o link de convite.',
        { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
      );
    }
  });

  // ── /offline ─────────────────────────────────────────────────────────────────
  bot.command('offline', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const m = await checarCadastro(chatId, ctx);
    if (!m) return;
    await db.setStatusOperacional(chatId, 'OFFLINE');
    await ctx.reply('🔴 Expediente encerrado.', Markup.removeKeyboard());
    console.log(`[BOT] ${m.nome} ficou OFFLINE via /offline`);
  });

  // ── /cancelar — cancela entrevista em andamento ───────────────────────────────
  bot.command('cancelar', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    sessoes.delete(chatId);
    await ctx.reply('✅ Conversa encerrada. Volte quando quiser!', Markup.removeKeyboard());
  });

  // ── /reset — reinicia estado da sessão ───────────────────────────────────────
  bot.command('reset', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    sessoes.delete(chatId);
    await ctx.reply('🔄 Estado resetado. Use o link de convite para iniciar o cadastro.');
  });

  // ── /sair e /desvincular ─────────────────────────────────────────────────────
  const handlerSair = async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const m = await db.getMotoboyByTelegramId(chatId);
    if (!m) {
      await ctx.reply('⚠️ Você não está cadastrado nesta loja.');
      return;
    }
    if ((m.pagamento_pendente || 0) > 0) {
      await ctx.reply('❌ Você possui acertos financeiros pendentes.\nEntre em contato com a loja antes de se desvincular.');
      return;
    }
    await db.deletarMotoboyByTelegramId(chatId);
    sessoes.delete(chatId);
    await ctx.reply('✅ Você foi desvinculado desta loja com sucesso.', Markup.removeKeyboard());
    console.log(`[BOT] Motoboy desvinculado: ${m.nome} (${chatId})`);
  };
  bot.command('sair', handlerSair);
  bot.command('desvincular', handlerSair);

  // ── GPS — localização ao vivo ─────────────────────────────────────────────────
  bot.on('location', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const m = await db.getMotoboyByTelegramId(chatId);
      if (!m) return; // não é motoboy cadastrado — descarta em silêncio

      const { latitude, longitude } = ctx.message.location;
      const isLive = !!ctx.message.location.live_period;

      if (!isLive) {
        await ctx.reply(
          '⚠️ Você enviou uma localização *fixa*.\n\nPara entrar no radar, use *Localização em Tempo Real*:\n📎 → Localização → Compartilhar ao vivo.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      _throttleGps(chatId, latitude, longitude);
      console.log(`[MOTOBOY] ${m.nome} (${chatId}) ONLINE via location — ${latitude.toFixed(5)},${longitude.toFixed(5)}`);
      await ctx.reply(
        `🟢 Ponto registrado! Você está *ONLINE* no radar da loja.\n\nFique atento às novas rotas.\n\nPara encerrar o expediente, pare de compartilhar a localização ou use /offline.`,
        { parse_mode: 'Markdown', ...tecladoPrincipal }
      );
    } catch (e) {
      console.error('[MOTOBOY] Erro no handler location:', e.message);
    }
  });

  // ── GPS ao vivo — edições (live updates periódicos) ───────────────────────────
  bot.on('edited_message', async (ctx) => {
    try {
      const msg = ctx.editedMessage;
      if (!msg || !('location' in msg)) return;
      const chatId = msg.chat.id.toString();
      const m = await db.getMotoboyByTelegramId(chatId);
      if (!m) return; // não é motoboy cadastrado — descarta em silêncio

      const { latitude, longitude } = msg.location;
      _throttleGps(chatId, latitude, longitude);
      console.log(`[MOTOBOY] ${m.nome} (${chatId}) ONLINE via edited_message — ${latitude.toFixed(5)},${longitude.toFixed(5)}`);
    } catch (e) {
      console.error('[MOTOBOY] Erro no handler edited_message:', e.message);
    }
  });

  // ── Bot-4: SOS ────────────────────────────────────────────────────────────────
  bot.hears('🆘 Pedir Ajuda (SOS)', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const m = await checarCadastro(chatId, ctx);
      if (!m) return;

      if (!['ONLINE', 'EM_ROTA', 'EM_ENTREGA'].includes(m.operacional_status)) {
        await ctx.reply('⚠️ Você precisa estar ONLINE para usar o SOS.\nCompartilhe sua localização para ativar o radar.');
        return;
      }

      sessoes.set(chatId, { etapa: 'SOS_CHAT', dados: {} });
      await db.criarChatSessao({ telegram_id: chatId, tipo: 'SOS_CHAT' });

      ceiaEmitter.emit('ceia:sse', {
        tipo: 'SOS',
        data: { telegram_id: chatId, motoboy_nome: m.nome, lat: m.lat, lng: m.lng },
      });

      await ctx.reply(
        '🆘 *Sinal de emergência enviado!*\n\nO operador foi notificado e entrará em contato. Aguarde.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ Encerrar emergência', 'cancelar_chat'),
          ]),
        }
      );
      console.log(`[BOT] SOS acionado por ${m.nome} (${chatId})`);
    } catch (e) {
      console.error('[BOT] Erro no handler SOS:', e.message);
    }
  });

  // ── Bot-4: Falar com Cliente ──────────────────────────────────────────────────
  bot.hears('💬 Falar com Cliente', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const m = await checarCadastro(chatId, ctx);
      if (!m) return;

      const rotas = await db.getRotasMotoboyByTelegramId(chatId);
      if (!rotas.length) {
        await ctx.reply('📦 Você não tem entregas ativas no momento.');
        return;
      }

      await ctx.reply(
        'Com qual cliente deseja falar?',
        Markup.inlineKeyboard(
          rotas.map(p => [
            Markup.button.callback(
              `${p.cliente_nome || 'Cliente'} — ${p.bairro || p.endereco?.split(',')[0] || ''}`,
              `chat_${p.id}`
            ),
          ])
        )
      );
    } catch (e) {
      console.error('[BOT] Erro no handler falar-com-cliente:', e.message);
    }
  });

  // ── Bot-4: abrir chat com cliente específico ──────────────────────────────────
  bot.action(/^chat_(\d+)$/, async (ctx) => {
    try {
      const pedidoId = +ctx.match[1];
      const chatId   = ctx.chat?.id?.toString() || ctx.from?.id?.toString();
      const m = await checarCadastro(chatId, ctx);
      if (!m) return;

      const rotas  = await db.getRotasMotoboyByTelegramId(chatId);
      const pedido = rotas.find(r => r.id === pedidoId);

      if (!pedido) {
        await ctx.answerCbQuery('Pedido não encontrado ou já entregue.');
        return;
      }
      if (!pedido.cliente_whatsapp) {
        await ctx.answerCbQuery('Cliente sem WhatsApp cadastrado.');
        await ctx.reply('❌ Este pedido não tem WhatsApp do cliente cadastrado.');
        return;
      }

      // Formata JID do Baileys: 55XXXXXXXXXX@s.whatsapp.net
      const jid = pedido.cliente_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';

      // Verifica se o cliente já está em atendimento por outro motoboy
      const sessaoExistente = await db.getChatSessaoPorTelefone(jid);
      if (sessaoExistente && sessaoExistente.telegram_id !== chatId) {
        await ctx.answerCbQuery('Cliente já em atendimento');
        await ctx.reply('⚠️ Este cliente já está em atendimento. Aguarde o encerramento.');
        return;
      }

      sessoes.set(chatId, {
        etapa: 'CHAT_CLIENTE',
        dados: { telefone_cliente: jid, nome_cliente: pedido.cliente_nome || 'Cliente', pedido_id: pedidoId },
      });
      await db.criarChatSessao({
        telegram_id:      chatId,
        tipo:             'CHAT_CLIENTE',
        telefone_cliente: jid,
        nome_cliente:     pedido.cliente_nome,
        pedido_id:        pedidoId,
      });

      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
      await ctx.answerCbQuery('Linha aberta!');
      await ctx.reply(
        `💬 Linha aberta com *${pedido.cliente_nome || 'Cliente'}*.\n\nEscreva sua mensagem e eu enviarei ao WhatsApp dele. O cliente não verá seu número.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('⬛ Encerrar chat', 'cancelar_chat'),
          ]),
        }
      );
      console.log(`[BOT] ${m.nome} abriu chat com ${pedido.cliente_nome} (${jid})`);
    } catch (e) {
      console.error('[BOT] Erro no handler chat_pedido:', e.message);
      try { await ctx.answerCbQuery('Erro ao abrir chat.'); } catch (_) {}
    }
  });

  // ── Bot-4: encerrar chat (SOS ou cliente) — acionado pelo motoboy ─────────────
  bot.action('cancelar_chat', async (ctx) => {
    try {
      const chatId = ctx.chat?.id?.toString() || ctx.from?.id?.toString();
      const s      = sessoes.get(chatId);
      const etapa  = s?.etapa;

      sessoes.delete(chatId);
      await db.encerrarChatSessao(chatId);

      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
      await ctx.answerCbQuery('Encerrado');

      if (etapa === 'SOS_CHAT') {
        ceiaEmitter.emit('ceia:sse', { tipo: 'SOS_ENCERRADO', data: { telegram_id: chatId } });
        await ctx.reply('✅ Emergência encerrada. Se precisar, acione novamente.', tecladoPrincipal);
      } else {
        await ctx.reply('✅ Chat encerrado.', tecladoPrincipal);
      }
    } catch (e) {
      console.error('[BOT] Erro no handler cancelar_chat:', e.message);
    }
  });

  // ── Bot-3: aceitar rota ───────────────────────────────────────────────────────
  bot.action(/^aceitar_(\d+)$/, async (ctx) => {
    try {
      const pacoteId = +ctx.match[1];
      const chatId   = ctx.chat?.id?.toString() || ctx.from?.id?.toString();
      const m = await checarCadastro(chatId, ctx);
      if (!m) return;

      // Ramifica por tipo de vínculo do motoboy
      const vinculo = (m.vinculo || 'Fixo').trim();
      const isNuvem = vinculo === 'Nuvem';

      if (isNuvem) {
        // Nuvem: aceite → aguardando_coleta (ainda precisa confirmar coleta no balcão)
        // Transação atômica: pacote E pedidos mudam juntos ou nenhum muda (causa-3)
        await db.moverPacoteComPedidos(
          pacoteId,
          { status: 'aguardando_coleta' },
          { status: 'aguardando_coleta' }
        );
        await db.setStatusOperacional(chatId, 'EM_ROTA');

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
        await ctx.answerCbQuery('✅ Rota aceita!');
        await ctx.reply('🔵 Rota aceita! Vá ao estabelecimento buscar o pedido.\n\nQuando coletar, o lojista confirmará a coleta e você receberá a liberação.\n\nDigite o código de 4 dígitos de cada pedido ao fazer a entrega.', tecladoPrincipal);

        ceiaEmitter.emit('ceia:sse', { tipo: 'ACEITE_ROTA', data: { pacote_id: pacoteId, motoboy_id: m.id, motoboy_nome: m.nome } });
        console.log(`[DESPACHO] aceite rota pacote ${pacoteId} — motoboy ${m.nome} tipo=NUVEM → aguardando coleta`);
      } else {
        // Fixo / Freelancer: aceite → direto EM_ROTA (estão no balcão, pegam e saem)
        // Transação atômica: pacote E pedidos mudam juntos ou nenhum muda (causa-3)
        await db.moverPacoteComPedidos(
          pacoteId,
          { status: 'em_rota', coletado_em: new Date().toISOString() },
          { status: 'em_rota' }
        );
        await db.setStatusOperacional(chatId, 'EM_ROTA');

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
        await ctx.answerCbQuery('✅ Rota aceita!');
        await ctx.reply('🔵 Rota aceita! Bom trabalho 🛵\n\nDigite o código de 4 dígitos de cada pedido ao fazer a entrega.', tecladoPrincipal);

        ceiaEmitter.emit('ceia:sse', { tipo: 'ACEITE_ROTA', data: { pacote_id: pacoteId, motoboy_id: m.id, motoboy_nome: m.nome } });
        console.log(`[DESPACHO] aceite rota pacote ${pacoteId} — motoboy ${m.nome} tipo=${vinculo.toUpperCase()} → direto EM_ROTA`);
      }
    } catch (e) {
      console.error('[DESPACHO] falha ao aceitar rota (rollback executado, estado não alterado):', e.message);
      try { await ctx.answerCbQuery('Erro ao aceitar. Tente novamente.'); } catch (_) {}
    }
  });

  // ── Bot-3: recusar rota ───────────────────────────────────────────────────────
  bot.action(/^recusar_(\d+)$/, async (ctx) => {
    try {
      const pacoteId = +ctx.match[1];
      const chatId   = ctx.chat?.id?.toString() || ctx.from?.id?.toString();
      const m = await checarCadastro(chatId, ctx);
      if (!m) return;

      // Reverte pacote para aguardando sem motoboy — apenas pedidos em_rota são revertidos
      // Transação atômica: pacote E pedidos mudam juntos ou nenhum muda (causa-3)
      await db.moverPacoteComPedidos(
        pacoteId,
        { status: 'aguardando', motoboy_id: null },
        { status: 'aguardando' },
        "AND status='em_rota'"
      );
      await db.setStatusOperacional(chatId, 'ONLINE');

      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
      await ctx.answerCbQuery('❌ Rota recusada');
      await ctx.reply('❌ Rota recusada. Aguarde novas rotas.', tecladoPrincipal);

      ceiaEmitter.emit('ceia:sse', { tipo: 'RECUSA_ROTA', data: { pacote_id: pacoteId, motoboy_id: m.id, motoboy_nome: m.nome } });
      console.log(`[BOT] ${m.nome} recusou rota — pacote ${pacoteId}`);
    } catch (e) {
      console.error('[DESPACHO] falha ao recusar rota (rollback executado, estado não alterado):', e.message);
      try { await ctx.answerCbQuery('Erro ao recusar. Tente novamente.'); } catch (_) {}
    }
  });

  // ── Bot-3: baixa de entrega (código 4 dígitos) ────────────────────────────────
  bot.hears(/^\d{4}$/, async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const m = await checarCadastro(chatId, ctx);
      if (!m) return;

      const codigo = ctx.message.text.trim();
      const rotas  = await db.getRotasMotoboyByTelegramId(chatId);

      // Encontra o pedido desta rota com este código — cada pedido tem código único
      const grupo = rotas.filter(r => r.codigo_entrega === codigo);
      if (!grupo.length) {
        await ctx.reply('❌ Código inválido ou pedido já entregue. Verifique o código e tente novamente.');
        return;
      }

      const now      = new Date().toISOString();
      const pacoteId = grupo[0].pacote_id;

      // Marca TODOS os pedidos do grupo como entregues e registra cada extrato financeiro
      for (const ped of grupo) {
        await db.patchPedido(ped.id, { status: 'finalizado', finalizado_em: now });
        await db.registrarEntrega({
          motoboy_id:          m.id,
          motoboy_telegram_id: chatId,
          origem:              'local',
          no_origem:           null,
          pedido_id:           ped.id,
          valor_entrega:       ped.taxa_entrega || 0,
          taxa_deslocamento:   ped.taxa_deslocamento || 0,
        });

        // Avisa o cliente que o pedido foi entregue e pede avaliação
        if (ped.cliente_whatsapp) {
          try {
            const { sendMessage } = require('../whatsapp/socket');
            const numero = ped.cliente_whatsapp.replace(/\D/g, '');
            await sendMessage(numero,
              `Seu pedido foi entregue! 🎉 Obrigado pela preferência.\n\n` +
              `De 1 a 5, como foi sua experiência com a entrega? (responda só o número)`
            );
            marcarAvaliacaoPendente(numero, ped.id);
            console.log(`[BOT] Avaliação solicitada — pedido #${ped.id} cliente ${numero}`);
          } catch (e) {
            console.error('[BOT] Falha ao enviar mensagem de avaliação:', e.message);
          }
        }
      }

      // Resumo para o motoboy
      const linhasPedidos = grupo
        .map(ped => `📦 *${ped.cliente_nome || 'Pedido'}* — ${ped.bairro || ped.endereco || ''} · R$ ${(+(ped.taxa_entrega||0)).toFixed(2).replace('.',',')}`)
        .join('\n');
      const taxaTotal = grupo.reduce((s, ped) => s + (+(ped.taxa_entrega||0)), 0);
      const plural    = grupo.length > 1 ? ` (${grupo.length} pedidos)` : '';
      await ctx.reply(
        `✅ Entrega confirmada${plural}!\n\n${linhasPedidos}\n\n💰 Total: R$ ${taxaTotal.toFixed(2).replace('.',',')}`,
        { parse_mode: 'Markdown' }
      );

      // Emite SSE para cada pedido baixado (o front atualiza o card com loadAndRender)
      for (const ped of grupo) {
        ceiaEmitter.emit('ceia:sse', { tipo: 'BAIXA_PEDIDO', data: { pedido_id: ped.id, pacote_id: pacoteId, finalizado: false } });
      }

      // Verifica se todos os pedidos restantes do pacote foram finalizados
      const restantes    = await db.getRotasMotoboyByTelegramId(chatId);
      const mesmosPacote = restantes.filter(r => r.pacote_id === pacoteId);

      const ids = grupo.map(p => `#${p.id}`).join(',');
      console.log(`[BOT] Baixa: ${m.nome} entregou código ${codigo} → pedido(s) ${ids} (${grupo.length}) baixados`);

      if (mesmosPacote.length === 0) {
        // Pacote completo — finaliza e libera motoboy
        await db.patchPacote(pacoteId, { status: 'finalizado', finalizado_em: now });
        await db.setStatusOperacional(chatId, 'ONLINE');
        await ctx.reply('🎉 Rota finalizada! Todos os pedidos entregues.\n\n🟢 Você está ONLINE e pronto para novas rotas.', tecladoPrincipal);
        ceiaEmitter.emit('ceia:sse', { tipo: 'BAIXA_PEDIDO', data: { pedido_id: grupo[0].id, pacote_id: pacoteId, finalizado: true } });
      } else {
        const pendentes = mesmosPacote.length;
        await ctx.reply(`📦 Ainda ${pendentes} entrega(s) nesta rota. Continue!`);
      }
    } catch (e) {
      console.error('[BOT] Erro no handler baixa:', e.message);
      await ctx.reply('❌ Erro interno. Tente novamente.').catch(() => {});
    }
  });

  // ── Mensagens de texto — wizard de cadastro ───────────────────────────────────
  bot.on('text', async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      const texto  = ctx.message.text;

      if (texto.startsWith('/')) return; // comandos tratados acima

      const s = sessoes.get(chatId);
      if (!s) return; // fora de entrevista — ignora

      // ── Bot-4: relay SOS → operador (SSE) ───────────────────────────────────
      if (s.etapa === 'SOS_CHAT') {
        const m = await db.getMotoboyByTelegramId(chatId).catch(() => null);
        ceiaEmitter.emit('ceia:sse', {
          tipo: 'SOS_MSG',
          data: { telegram_id: chatId, motoboy_nome: m?.nome || '?', texto },
        });
        await ctx.reply('📨 Mensagem enviada para o operador.');
        return;
      }

      // ── Bot-4: relay CHAT_CLIENTE → WhatsApp ────────────────────────────────
      if (s.etapa === 'CHAT_CLIENTE') {
        const { telefone_cliente, nome_cliente } = s.dados;
        try {
          const { sendMessage } = require('../whatsapp/socket');
          await sendMessage(telefone_cliente, texto);
          await ctx.reply('✅ Enviado!');
        } catch (e) {
          console.error('[BOT] Erro ao enviar WhatsApp relay:', e.message);
          await ctx.reply('❌ Falha ao enviar mensagem. Tente novamente.');
        }
        return;
      }

      switch (s.etapa) {

        case 'NOME': {
          const nome = texto.trim();
          if (nome.length < 2) {
            await ctx.reply('Por favor, informe um nome válido (mínimo 2 caracteres):');
            return;
          }
          await avancarEntrevista(chatId, 'nome', nome, 'WHATSAPP');
          await ctx.reply(
            'Perfeito! Agora, qual é o seu *WhatsApp*?\n(somente números com DDD, ex: 31999998888)',
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'WHATSAPP': {
          const numero = texto.replace(/\D/g, '');
          if (numero.length < 10) {
            await ctx.reply('❌ Número inválido. Digite somente os números com DDD (ex: 31999998888):');
            return;
          }
          // Grava em motoboys.whatsapp — NÃO em cpf (ver Risco E do plano de migração)
          await avancarEntrevista(chatId, 'whatsapp', numero, 'VINCULO');
          await ctx.reply(
            'Qual o seu *Vínculo* com a loja?',
            { parse_mode: 'Markdown', ...Markup.keyboard([['Fixo', 'Freelancer']]).oneTime().resize() }
          );
          break;
        }

        case 'VINCULO': {
          if (texto !== 'Fixo' && texto !== 'Freelancer') {
            await ctx.reply(
              'Por favor, selecione uma das opções:',
              Markup.keyboard([['Fixo', 'Freelancer']]).oneTime().resize()
            );
            return;
          }
          await avancarEntrevista(chatId, 'vinculo', texto, 'PIX');
          await ctx.reply(
            'Qual a sua *Chave PIX* para recebimentos?',
            { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
          );
          break;
        }

        case 'PIX': {
          await avancarEntrevista(chatId, 'pix', texto.trim(), 'VEICULO');
          await ctx.reply(
            'Qual é o seu *Veículo*? (ex: Moto, Scooter, Carro)',
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'VEICULO': {
          // Lê dados antes de avançar (avancarEntrevista muda a sessão)
          const dadosFinais = { ...s.dados, veiculo: texto.trim() };
          await avancarEntrevista(chatId, 'veiculo', texto.trim(), null);
          sessoes.delete(chatId);

          // Garante operacional_status OFFLINE (estado inicial pós-cadastro)
          await db.setStatusOperacional(chatId, 'OFFLINE');

          if (dadosFinais.vinculo === 'Freelancer') {
            // Registro no Hub externo é pendente — fase Nuvem
            console.log(`[BOT] Freelancer cadastrado: ${dadosFinais.nome} (${chatId}) — registro no Hub pendente (fase Nuvem)`);
          }

          await ctx.reply(
            `✅ Cadastro concluído com sucesso!\n\nAgora compartilhe sua *Localização em Tempo Real* aqui no chat para entrar no radar e começar a receber rotas. 🛵`,
            { parse_mode: 'Markdown', ...tecladoPrincipal }
          );
          console.log(`[BOT] Cadastro finalizado: ${dadosFinais.nome} (${chatId})`);
          break;
        }

        default:
          // Etapa desconhecida — limpa sessão corrompida
          sessoes.delete(chatId);
      }
    } catch (e) {
      console.error('[BOT] Erro no handler text:', e.message);
    }
  });
}

// ─── Ciclo de vida ─────────────────────────────────────────────────────────────

async function iniciarTelegram() {
  try {
    const token = await db.getConfig('telegram_token').catch(() => null);
    if (!token) {
      console.log('[BOT] Telegram desabilitado (sem token em Configurações → Chaves de API)');
      return;
    }

    // Para instância anterior antes de criar nova
    await pararTelegram();

    _bot = new Telegraf(token);

    _bot.catch((err, ctx) => {
      console.error(`[BOT] Erro no handler "${ctx?.updateType}":`, err?.message || err);
    });

    registrarHandlers(_bot);

    // Launch em background — não bloqueia o servidor
    _bot.launch().catch(err => {
      if (err?.message !== 'Aborted') {
        console.error('[BOT] Falha no launch:', err?.message || err);
      }
      _online = false;
    });

    // Aguarda conexão inicial e obtém info do bot
    await new Promise(r => setTimeout(r, 1500));
    try {
      const info = await _bot.telegram.getMe();
      _username = info.username;
      _online   = true;
      console.log(`[BOT] Telegram online como @${_username}`);
    } catch (e) {
      console.error('[BOT] Não foi possível obter bot info:', e.message);
      _online = false;
    }

    // Cron: marca OFFLINE motoboys sem sinal GPS há mais de 5 min (a cada 2 min)
    if (_radarTimer) clearInterval(_radarTimer);
    _radarTimer = setInterval(async () => {
      try {
        const n = await db.limparRadarInativo();
        if (n > 0) console.log(`[BOT] Radar: ${n} motoboy(s) ficaram OFFLINE por inatividade.`);
      } catch (e) {
        console.error('[BOT] Erro no cron radar:', e.message);
      }
    }, 2 * 60 * 1000);

    process.once('SIGINT',  () => pararTelegram().catch(() => {}));
    process.once('SIGTERM', () => pararTelegram().catch(() => {}));

  } catch (err) {
    console.error('[BOT] Falha ao iniciar Telegram:', err?.message || err);
    _online = false;
  }
}

async function pararTelegram() {
  if (_radarTimer) {
    clearInterval(_radarTimer);
    _radarTimer = null;
  }
  if (_bot) {
    try { _bot.stop('RELOAD'); } catch (_) {}
    _bot      = null;
    _online   = false;
    _username = null;
    console.log('[BOT] Telegram parado.');
  }
}

/** Retorna estado atual do bot para a API. */
function getBotInfo() {
  return { online: _online, username: _username || null };
}

// Reinicia bot automaticamente quando o token muda nas Configurações
ceiaEmitter.on('ceia:telegram-token-changed', async () => {
  console.log('[BOT] Token alterado — reiniciando bot...');
  try {
    await iniciarTelegram();
  } catch (e) {
    console.error('[BOT] Erro ao reiniciar após mudança de token:', e.message);
  }
});

module.exports = { iniciarTelegram, pararTelegram, getBotInfo, enviarRotaParaMotoboy, enviarMensagemBot, encerrarSessaoBot };
