/**
 * CEIA OS — Tela de Atendimentos
 *
 * Histórico de conversa por cliente, modo atendimento humano (pausa IA),
 * badge de não-lidas.
 */
/* global window, document */

const Atendimentos = (() => {
  'use strict';

  // ── Estado ───────────────────────────────────────────────────────────────────
  let _el            = null;
  let _clientes      = [];
  let _ativo         = null;   // whatsapp do cliente selecionado
  let _modoManual    = false;  // modo atendimento humano ativo para _ativo
  let _pollTimer     = null;
  let _busca         = '';
  let _listaListener = null;
  let _docListeners  = [];     // [{ evt, fn }] para remover no unmount

  // ── API helper ────────────────────────────────────────────────────────────────
  function _api(path) {
    return ((window.CEIA && window.CEIA.apiBase) || 'http://127.0.0.1:3000') + path;
  }

  // ── Formatação ────────────────────────────────────────────────────────────────
  function _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function _fmtBRL(v) {
    return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function _dataHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
           ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function _horaMsg(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hoje = new Date();
    if (d.toDateString() === hoje.toDateString()) {
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function _tempoAtras(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 60)  return `${m}min atrás`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h atrás`;
    return `${Math.floor(h / 24)}d atrás`;
  }
  function _statusBadge(status) {
    const map = {
      preparacao:           ['#22c55e', 'Em preparo'],
      aguardando_pagamento: ['#f59e0b', 'Aguard. pagto'],
      entregue:             ['#64748b', 'Entregue'],
      cancelado:            ['#ef4444', 'Cancelado'],
    };
    const [cor, label] = map[status] || ['#94a3b8', status || '—'];
    return `<span style="display:inline-block;padding:2px 7px;border-radius:10px;
                         background:${cor}22;color:${cor};font-size:10px;font-weight:600;
                         white-space:nowrap">${_esc(label)}</span>`;
  }

  // ── Carrega lista de clientes ─────────────────────────────────────────────────
  async function _carregar() {
    try {
      const r   = await fetch(_api('/api/atendimentos/clientes'));
      const d   = await r.json();
      _clientes = d.clientes || [];
      _renderLista();
    } catch (_) {}
  }

  function _filtrados() {
    if (!_busca) return _clientes;
    const q = _busca.toLowerCase();
    return _clientes.filter(c =>
      (c.nome || '').toLowerCase().includes(q) || (c.whatsapp || '').includes(q)
    );
  }

  // ── Render lista lateral ──────────────────────────────────────────────────────
  function _renderLista() {
    const lista = _el && _el.querySelector('.cr-lista');
    if (!lista) return;
    const itens = _filtrados();
    if (!itens.length) {
      lista.innerHTML = `<div style="padding:32px 20px;text-align:center;color:var(--text-dim);font-size:13px">
        ${_clientes.length ? 'Nenhum resultado.' : 'Nenhum cliente com pedido ainda.'}</div>`;
      return;
    }
    lista.innerHTML = itens.map(c => `
      <div class="cr-item ${_ativo === c.whatsapp ? 'cr-item--ativo' : ''}"
           data-whatsapp="${_esc(c.whatsapp)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;min-width:0">
          <span style="font-weight:600;font-size:13px;color:var(--text);
                       overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">
            ${_esc(c.nome || c.whatsapp)}
          </span>
          <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">
            ${_tempoAtras(c.ultimo_pedido_em)}
          </span>
        </div>
        <div style="margin-top:4px;display:flex;gap:8px;align-items:center">
          <span style="font-size:11px;color:var(--text-muted)">${c.total_pedidos} pedido${c.total_pedidos !== 1 ? 's' : ''}</span>
          <span style="font-size:10px;color:var(--text-dim)">·</span>
          <span style="font-size:11px;color:var(--teal)">${_fmtBRL(c.total_gasto)}</span>
        </div>
      </div>`).join('');
  }

  // ── Abre detalhe ─────────────────────────────────────────────────────────────
  async function _abrirCliente(whatsapp) {
    _ativo = whatsapp;
    _modoManual = false;
    _renderLista();

    const detalhe = _el && _el.querySelector('.cr-detalhe');
    if (!detalhe) return;

    detalhe.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
      height:100%;color:var(--text-dim);font-size:13px">Carregando...</div>`;

    try {
      const [clienteRes, chatRes] = await Promise.all([
        fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}`)),
        fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}/chat`)),
      ]);
      const clienteData = await clienteRes.json();
      const chatData    = await chatRes.json().catch(() => ({ msgs: [], modo_manual: false }));

      if (!clienteRes.ok || !clienteData.info) {
        detalhe.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
          height:100%;color:var(--text-muted);font-size:13px">
          Cliente não encontrado.</div>`;
        return;
      }

      _modoManual = !!(chatData.modo_manual);
      _renderDetalhe(detalhe, clienteData.info, clienteData.pedidos || [], chatData.msgs || []);

      // Marca como lidas
      fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}/ler`), { method: 'POST' }).catch(() => {});
      if (typeof window._refreshBadgeAtendimentos === 'function') window._refreshBadgeAtendimentos();

    } catch (e) {
      if (detalhe) detalhe.innerHTML = `<div style="display:flex;align-items:center;
        justify-content:center;height:100%;color:var(--text-muted);font-size:13px">
        Erro: ${_esc(e.message)}</div>`;
    }
  }

  // ── Renderiza painel de detalhe ───────────────────────────────────────────────
  function _renderDetalhe(detalheEl, info, pedidos, msgs) {
    if (!detalheEl) return;
    if (!info) {
      detalheEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;
        height:100%;color:var(--text-dim);font-size:13px">Selecione um cliente</div>`;
      return;
    }

    const modoAtivo = _modoManual;

    detalheEl.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-width:0;overflow:hidden">

        <!-- Header compacto -->
        <div class="cr-chat-header">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px;color:var(--text);
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${_esc(info.nome || info.whatsapp)}
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:1px">
              ${_esc(info.whatsapp)} ·
              ${info.total_pedidos} pedido${info.total_pedidos !== 1 ? 's' : ''} ·
              <span style="color:var(--teal)">${_fmtBRL(info.total_gasto)}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;align-items:center;flex-wrap:wrap">
            <button data-action="ver-pedidos" data-whatsapp="${_esc(info.whatsapp)}"
                    class="cr-btn-ghost" title="Ver pedidos do cliente">
              📋 Pedidos (${pedidos.length})
            </button>
            ${modoAtivo
              ? `<button data-action="devolver-ia" data-whatsapp="${_esc(info.whatsapp)}"
                         class="cr-btn-devolver" title="Devolver atendimento à IA">
                   Devolver à IA
                 </button>`
              : `<button data-action="assumir" data-whatsapp="${_esc(info.whatsapp)}"
                         class="cr-btn-chat" title="Pausar IA e assumir atendimento">
                   Chamar no chat
                 </button>`
            }
            <button data-action="ocultar" data-whatsapp="${_esc(info.whatsapp)}"
                    class="cr-btn-ocultar" title="Ocultar cliente">
              Ocultar
            </button>
          </div>
        </div>

        <!-- Indicador de modo humano -->
        <div class="cr-modo-badge ${modoAtivo ? '' : 'cr-modo-badge--oculto'}">
          <span style="font-size:11px">⚠ IA pausada — atendimento humano ativo</span>
        </div>

        <!-- Thread de mensagens -->
        <div class="cr-thread" id="cr-thread">
          ${_renderMsgs(msgs)}
        </div>

        <!-- Input de envio -->
        <div class="cr-input-area">
          <textarea class="cr-msg-textarea" id="cr-textarea"
                    placeholder="Digite a mensagem para o cliente... (Enter envia, Shift+Enter nova linha)"
                    rows="2"></textarea>
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
            <button data-action="enviar-msg" data-whatsapp="${_esc(info.whatsapp)}"
                    class="cr-btn-enviar" id="cr-btn-enviar">
              Enviar
            </button>
            <span class="cr-msg-status" id="cr-msg-status"></span>
          </div>
        </div>
      </div>`;

    _scrollThreadFim();

    // Bind Enter no textarea
    detalheEl.querySelector('#cr-textarea')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      await _enviarMensagem(info.whatsapp);
    });
  }

  // ── Render mensagens do thread ────────────────────────────────────────────────
  function _renderMsgs(msgs) {
    if (!msgs || !msgs.length) {
      return `<div style="padding:24px 0;text-align:center;color:var(--text-dim);font-size:12px">
        Nenhuma mensagem ainda.</div>`;
    }
    return msgs.map(m => _renderUmaMsg(m.de, m.texto, m.criado_em)).join('');
  }

  function _renderUmaMsg(de, texto, criado_em) {
    const isCliente   = de === 'cliente';
    const isAtendente = de === 'atendente';
    const label = isCliente ? 'Cliente' : isAtendente ? 'Atendente' : 'IA';
    const corFundo = isCliente
      ? 'rgba(255,255,255,.06)'
      : isAtendente
      ? 'rgba(0,208,183,.14)'
      : 'rgba(100,120,200,.14)';
    const corLabel = isCliente ? 'var(--text-dim)' : isAtendente ? 'var(--teal)' : '#8899ee';
    const align    = isCliente ? 'flex-start' : 'flex-end';

    return `<div class="cr-msg-row" style="justify-content:${align}">
      <div class="cr-msg-bubble" style="background:${corFundo}">
        <div class="cr-msg-meta">
          <span style="color:${corLabel}">${_esc(label)}</span>
          <span>${_esc(_horaMsg(criado_em))}</span>
        </div>
        <div class="cr-msg-texto">${_esc(texto)}</div>
      </div>
    </div>`;
  }

  function _scrollThreadFim() {
    const thread = _el && _el.querySelector('#cr-thread');
    if (thread) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
  }

  // ── Append única mensagem no thread ativo ────────────────────────────────────
  function _appendMsgAtiva(de, texto, criado_em) {
    const thread = _el && _el.querySelector('#cr-thread');
    if (!thread) return;
    // Remove placeholder "Nenhuma mensagem"
    const placeholder = thread.querySelector('div[style*="Nenhuma mensagem"]');
    if (placeholder) placeholder.remove();
    const div = document.createElement('div');
    div.innerHTML = _renderUmaMsg(de, texto, criado_em || new Date().toISOString());
    thread.appendChild(div.firstElementChild);
    _scrollThreadFim();
  }

  // ── Enviar mensagem via WhatsApp ─────────────────────────────────────────────
  async function _enviarMensagem(whatsapp) {
    const ta     = _el && _el.querySelector('#cr-textarea');
    const status = _el && _el.querySelector('#cr-msg-status');
    const btn    = _el && _el.querySelector('#cr-btn-enviar');
    if (!ta) return;

    const texto = ta.value.trim();
    if (!texto) { ta.focus(); return; }

    if (btn) btn.disabled = true;
    if (status) { status.style.color = ''; status.textContent = 'Enviando...'; }

    try {
      const r    = await fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}/mensagem`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ texto }),
      });
      const data = await r.json();
      if (!data.ok) {
        if (status) { status.style.color = '#ef4444'; status.textContent = data.error || 'Falha ao enviar.'; }
        window.Toast?.error(data.error || 'Falha ao enviar — WhatsApp conectado?');
      } else {
        ta.value = '';
        ta.focus();
        if (status) { status.style.color = '#22c55e'; status.textContent = 'Enviada ✓'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 2500);
        // Adiciona localmente no thread (não espera SSE)
        _appendMsgAtiva('atendente', texto, new Date().toISOString());
      }
    } catch (e) {
      if (status) { status.style.color = '#ef4444'; status.textContent = 'Erro: ' + e.message; }
      window.Toast?.error('Erro ao enviar: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Assumir / Devolver à IA ───────────────────────────────────────────────────
  async function _assumir(whatsapp) {
    const r = await fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}/assumir`), { method: 'POST' }).catch(() => null);
    if (!r?.ok) { window.Toast?.error('Erro ao assumir atendimento'); return; }
    _modoManual = true;
    _atualizarModoBadge(true);
    window.Toast?.success('IA pausada — você está atendendo.');
  }

  async function _devolverIA(whatsapp) {
    const r = await fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}/devolver-ia`), { method: 'POST' }).catch(() => null);
    if (!r?.ok) { window.Toast?.error('Erro ao devolver à IA'); return; }
    _modoManual = false;
    _atualizarModoBadge(false);
    window.Toast?.success('IA retomou o atendimento.');
    if (typeof window._refreshBadgeAtendimentos === 'function') window._refreshBadgeAtendimentos();
  }

  function _atualizarModoBadge(ativo) {
    if (!_el) return;
    const badge = _el.querySelector('.cr-modo-badge');
    if (badge) badge.classList.toggle('cr-modo-badge--oculto', !ativo);
    // Troca botão Assumir ↔ Devolver
    const btnAssumir  = _el.querySelector('[data-action="assumir"]');
    const btnDevolver = _el.querySelector('[data-action="devolver-ia"]');
    const wa          = _ativo;
    if (btnAssumir && ativo) {
      const novo = btnAssumir.cloneNode(true);
      novo.dataset.action    = 'devolver-ia';
      novo.dataset.whatsapp  = wa;
      novo.className         = 'cr-btn-devolver';
      novo.title             = 'Devolver atendimento à IA';
      novo.textContent       = 'Devolver à IA';
      btnAssumir.replaceWith(novo);
    } else if (btnDevolver && !ativo) {
      const novo = btnDevolver.cloneNode(true);
      novo.dataset.action    = 'assumir';
      novo.dataset.whatsapp  = wa;
      novo.className         = 'cr-btn-chat';
      novo.title             = 'Pausar IA e assumir atendimento';
      novo.textContent       = 'Chamar no chat';
      btnDevolver.replaceWith(novo);
    }
  }

  // ── Ocultar cliente ───────────────────────────────────────────────────────────
  async function _ocultar(whatsapp) {
    const ok = await window.Dialog?.confirm(
      'Ocultar cliente?',
      'O cliente some da lista. Reaparece automaticamente ao fazer um novo pedido.'
    );
    if (!ok) return;
    try {
      const r    = await fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}/ocultar`), { method: 'POST' });
      const data = await r.json();
      if (!data.ok) { window.Toast?.error(data.error || 'Falha'); return; }
      window.Toast?.success('Cliente ocultado.');
      _ativo = null;
      _modoManual = false;
      const detalhe = _el && _el.querySelector('.cr-detalhe');
      _renderDetalhe(detalhe, null, [], []);
      await _carregar();
    } catch (e) {
      window.Toast?.error('Erro: ' + e.message);
    }
  }

  // ── Modal de pedidos do cliente ──────────────────────────────────────────────
  async function _abrirPedidosModal(whatsapp) {
    const url = _api(`/api/atendimentos/clientes/${encodeURIComponent(whatsapp)}`);
    const r = await fetch(url).catch(() => null);
    if (!r?.ok) { window.Toast?.error('Erro ao carregar pedidos'); return; }
    const { pedidos = [] } = await r.json();
    if (!pedidos.length) { window.Dialog?.alert('Nenhum pedido encontrado para este cliente.'); return; }

    const linhas = pedidos.map(p => {
      let itensTexto = '';
      try {
        const its = JSON.parse(p.itens || '[]');
        itensTexto = its.map(i => `${i.quantidade || i.qtd || 1}× ${i.nome}`).join(', ');
      } catch (_) {}
      return `
        <div data-action="abrir-pedido" data-codigo="${_esc(p.codigo)}"
             style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);
                    cursor:pointer;user-select:none"
             onmouseenter="this.style.background='rgba(255,255,255,.04)'"
             onmouseleave="this.style.background=''">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span style="font-family:monospace;font-size:12px;color:var(--text);font-weight:600">#${_esc(p.codigo)}</span>
            <span style="font-size:11px;color:var(--text-muted)">${_dataHora(p.criado_em)}</span>
            <span style="font-size:12px;color:var(--teal);font-weight:600">${_fmtBRL(p.total)}</span>
          </div>
          ${itensTexto ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(itensTexto)}</div>` : ''}
        </div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;
                  width:min(94vw,480px);max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
          <span style="font-size:13px;font-weight:600;color:var(--text)">Pedidos</span>
          <button id="at-ped-close" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:20px;padding:0 4px;line-height:1">×</button>
        </div>
        <div style="flex:1;overflow-y:auto">${linhas}</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#at-ped-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.addEventListener('click', async e => {
      const row = e.target.closest('[data-action="abrir-pedido"]');
      if (row) { await _abrirPedidoModal(row.dataset.codigo); }
    });
  }

  // ── Modal de pedido completo ──────────────────────────────────────────────────
  async function _abrirPedidoModal(codigo) {
    const url  = _api(`/api/atendimentos/pedidos/${encodeURIComponent(codigo)}`);
    let pedido;
    try {
      const r = await fetch(url);
      pedido  = await r.json();
      if (!r.ok) { window.Toast?.error(pedido.error || 'Pedido não encontrado'); return; }
    } catch (e) {
      window.Toast?.error('Erro ao carregar pedido: ' + e.message);
      return;
    }

    const STATUS_MAP = {
      preparacao:           ['#22c55e', 'Em preparo'],
      aguardando_pagamento: ['#f59e0b', 'Aguard. pagamento'],
      finalizado:           ['#64748b', 'Finalizado'],
      entregue:             ['#64748b', 'Entregue'],
      cancelado:            ['#ef4444', 'Cancelado'],
    };
    const [sCor, sLabel] = STATUS_MAP[pedido.status] || ['#94a3b8', pedido.status || '—'];

    const linhasItens = (pedido.itens || []).map(it => {
      const adicsHtml = Array.isArray(it.adicionais)
        ? it.adicionais.map(a =>
            `<div style="font-size:11px;color:var(--text-dim);padding-left:12px">+ ${_esc(a)}</div>`
          ).join('')
        : '';
      return `
        <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <div style="display:flex;align-items:baseline;gap:4px">
            <span style="font-size:13px;color:var(--text);font-weight:500;flex:1">
              ${_esc(it.quantidade)}× ${_esc(it.nome)}
            </span>
            <span style="font-size:13px;color:var(--teal);font-weight:600;white-space:nowrap;flex-shrink:0">
              ${_fmtBRL(it.subtotal)}
            </span>
          </div>
          ${adicsHtml}
        </div>`;
    }).join('');

    const endParts = [pedido.cliente?.endereco, pedido.cliente?.complemento, pedido.cliente?.bairro].filter(Boolean);
    const temDesconto = (pedido.desconto_aplicado || 0) > 0;

    const inner = `
      <div style="padding:4px 0 14px;border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:17px;font-weight:700;color:var(--text);font-family:monospace;letter-spacing:.05em">#${_esc(pedido.codigo)}</span>
          <span style="display:inline-block;padding:3px 9px;border-radius:10px;background:${sCor}22;color:${sCor};font-size:11px;font-weight:600">${_esc(sLabel)}</span>
          <span style="font-size:12px;color:var(--text-muted)">${_dataHora(pedido.criado_em)}</span>
        </div>
      </div>
      ${pedido.cliente?.nome || endParts.length ? `
      <div style="margin-bottom:14px;padding:10px 12px;background:rgba(255,255,255,.04);border-radius:8px;border:1px solid rgba(255,255,255,.08)">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);margin-bottom:6px">Cliente</div>
        ${pedido.cliente?.nome ? `<div style="font-size:13px;color:var(--text);font-weight:600">${_esc(pedido.cliente.nome)}</div>` : ''}
        ${endParts.length ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${_esc(endParts.join(' — '))}</div>` : ''}
      </div>` : ''}
      <div style="margin-bottom:14px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);margin-bottom:8px">Itens</div>
        ${linhasItens || '<div style="color:var(--text-dim);font-size:13px">Sem itens.</div>'}
      </div>
      ${pedido.observacoes ? `<div style="margin-bottom:14px;padding:8px 12px;background:rgba(255,255,255,.04);border-radius:6px;font-size:12px;color:var(--text-muted)">
        <strong style="color:var(--text)">Obs:</strong> ${_esc(pedido.observacoes)}</div>` : ''}
      <div style="padding:10px 12px;background:rgba(255,255,255,.04);border-radius:8px;border:1px solid rgba(255,255,255,.08)">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);margin-bottom:8px">Resumo</div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
          <span style="color:var(--text-muted)">Subtotal</span><span style="color:var(--text)">${_fmtBRL(pedido.subtotal)}</span>
        </div>
        ${temDesconto ? `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
          <span style="color:var(--text-muted)">Desconto</span><span style="color:#22c55e">− ${_fmtBRL(pedido.desconto_aplicado)}</span>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
          <span style="color:var(--text-muted)">Taxa de entrega</span>
          <span style="color:var(--text)">${pedido.taxa_entrega > 0 ? _fmtBRL(pedido.taxa_entrega) : 'Grátis'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;padding:8px 0 4px;border-top:1px solid rgba(255,255,255,.12);margin-top:4px">
          <span style="color:var(--text)">Total</span><span style="color:var(--teal)">${_fmtBRL(pedido.total)}</span>
        </div>
        ${pedido.forma_pagamento ? `<div style="font-size:11px;color:var(--text-muted);text-align:right">${_esc(pedido.forma_pagamento)}</div>` : ''}
      </div>`;

    await window.Dialog.modal(inner);
  }

  // ── CSS ───────────────────────────────────────────────────────────────────────
  const _CSS = `
    .cr-layout {
      display: flex;
      height: 100%;
      gap: 0;
      background: var(--bg);
      overflow: hidden;
    }
    .cr-sidebar {
      width: 260px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .cr-sidebar-header {
      padding: 14px 16px 10px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .cr-sidebar-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .cr-busca {
      width: 100%;
      box-sizing: border-box;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--text);
      font-size: 12px;
      font-family: inherit;
      outline: none;
      transition: border-color .15s;
    }
    .cr-busca:focus { border-color: var(--border-hover); }
    .cr-lista {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .cr-lista::-webkit-scrollbar { width: 3px; }
    .cr-lista::-webkit-scrollbar-thumb { background: var(--border); }
    .cr-item {
      padding: 11px 16px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
      transition: background .12s;
      box-sizing: border-box;
      min-width: 0;
      overflow: hidden;
    }
    .cr-item:hover { background: rgba(255,255,255,.04); }
    .cr-item--ativo { background: rgba(0,208,183,.06) !important; border-left: 2px solid var(--teal); }
    .cr-detalhe {
      flex: 1;
      overflow: hidden;
      min-width: 0;
    }
    /* ── Chat layout ── */
    .cr-chat-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-width: 0;
    }
    .cr-modo-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 14px;
      background: rgba(239,68,68,.12);
      border-bottom: 1px solid rgba(239,68,68,.2);
      color: #ef4444;
      flex-shrink: 0;
    }
    .cr-modo-badge--oculto { display: none; }
    .cr-thread {
      flex: 1;
      overflow-y: auto;
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .cr-thread::-webkit-scrollbar { width: 3px; }
    .cr-thread::-webkit-scrollbar-thumb { background: var(--border); }
    .cr-msg-row {
      display: flex;
      max-width: 100%;
    }
    .cr-msg-bubble {
      max-width: 78%;
      border-radius: 8px;
      padding: 7px 10px;
      border: 1px solid rgba(255,255,255,.06);
    }
    .cr-msg-meta {
      display: flex;
      gap: 8px;
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 3px;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: var(--text-dim);
    }
    .cr-msg-texto {
      font-size: 12px;
      color: var(--text);
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cr-input-area {
      padding: 8px 14px 10px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .cr-msg-textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
      resize: vertical;
      outline: none;
      transition: border-color .15s;
    }
    .cr-msg-textarea:focus { border-color: var(--teal); }
    .cr-btn-enviar {
      padding: 5px 14px;
      background: var(--teal);
      border: none;
      border-radius: 6px;
      color: #000;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    .cr-btn-enviar:hover { opacity: .85; }
    .cr-btn-enviar:disabled { opacity: .5; cursor: not-allowed; }
    .cr-btn-chat {
      padding: 4px 10px;
      background: rgba(0,208,183,.12);
      border: 1px solid var(--teal);
      color: var(--teal);
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
      transition: background .15s;
      white-space: nowrap;
    }
    .cr-btn-chat:hover { background: rgba(0,208,183,.22); }
    .cr-btn-devolver {
      padding: 4px 10px;
      background: rgba(239,68,68,.12);
      border: 1px solid #ef4444;
      color: #ef4444;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .cr-btn-devolver:hover { background: rgba(239,68,68,.22); }
    .cr-btn-ocultar {
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
      transition: border-color .15s, color .15s;
      white-space: nowrap;
    }
    .cr-btn-ocultar:hover { border-color: #ef4444; color: #ef4444; }
    .cr-btn-ghost {
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .cr-btn-ghost:hover { border-color: var(--border-hover); color: var(--text); }
    .cr-msg-status { font-size: 11px; color: var(--text-muted); }
  `;

  let _cssInjected = false;
  function _injectCSS() {
    if (_cssInjected) return;
    const st = document.createElement('style');
    st.id    = 'atendimentos-css';
    st.textContent = _CSS;
    document.head.appendChild(st);
    _cssInjected = true;
  }

  // ── Mount / Unmount ───────────────────────────────────────────────────────────
  async function mount(el) {
    _injectCSS();
    _el = el;
    _el.style.display = 'flex';
    _el.style.height  = '100%';
    _el.style.padding = '0';
    _el.classList.add('active');

    _el.innerHTML = `
      <div class="cr-layout">
        <div class="cr-sidebar">
          <div class="cr-sidebar-header">
            <div class="cr-sidebar-title">Clientes Recentes</div>
            <input class="cr-busca" type="search" placeholder="Buscar por nome ou número...">
          </div>
          <div class="cr-lista">
            <div style="padding:32px 20px;text-align:center;color:var(--text-dim);font-size:13px">Carregando...</div>
          </div>
        </div>
        <div class="cr-detalhe">
          <div style="display:flex;align-items:center;justify-content:center;
                      height:100%;color:var(--text-dim);font-size:13px">
            Selecione um cliente
          </div>
        </div>
      </div>`;

    // ── Delegação: lista lateral ──────────────────────────────────────────────
    const lista = _el.querySelector('.cr-lista');
    _listaListener = (e) => {
      const item = e.target.closest('.cr-item');
      if (!item) return;
      const wa = item.dataset.whatsapp;
      if (wa) _abrirCliente(wa);
    };
    lista.addEventListener('click', _listaListener);

    // ── Delegação: painel de detalhe ─────────────────────────────────────────
    const detalheEl = _el.querySelector('.cr-detalhe');
    detalheEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const wa  = btn.dataset.whatsapp;
      const act = btn.dataset.action;
      if (act === 'assumir')      { if (wa) await _assumir(wa); return; }
      if (act === 'devolver-ia')  { if (wa) await _devolverIA(wa); return; }
      if (act === 'ocultar')      { if (wa) await _ocultar(wa); return; }
      if (act === 'ver-pedidos')  { if (wa) await _abrirPedidosModal(wa); return; }
      if (act === 'enviar-msg')   { if (wa) await _enviarMensagem(wa); return; }
    });

    // ── Busca ─────────────────────────────────────────────────────────────────
    _el.querySelector('.cr-busca').addEventListener('input', (e) => {
      _busca = (e.target.value || '').trim();
      _renderLista();
    });

    // ── SSE: mensagem manual do cliente ──────────────────────────────────────
    const onMensagemManual = (e) => {
      const { numero, texto } = e.detail?.data || e.detail || {};
      if (!numero || numero !== _ativo) return;
      _appendMsgAtiva('cliente', texto, new Date().toISOString());
      // Marca como lida imediatamente (tela está aberta)
      fetch(_api(`/api/atendimentos/clientes/${encodeURIComponent(numero)}/ler`), { method: 'POST' }).catch(() => {});
    };
    document.addEventListener('wa:mensagem_manual', onMensagemManual);
    _docListeners.push({ evt: 'wa:mensagem_manual', fn: onMensagemManual });

    // ── SSE: modo assumido/devolvido por outra instância ─────────────────────
    const onAssumido = (e) => {
      const { numero } = e.detail?.data || e.detail || {};
      if (numero === _ativo && !_modoManual) { _modoManual = true; _atualizarModoBadge(true); }
    };
    document.addEventListener('wa:atendimento_assumido', onAssumido);
    _docListeners.push({ evt: 'wa:atendimento_assumido', fn: onAssumido });

    const onDevolvido = (e) => {
      const { numero } = e.detail?.data || e.detail || {};
      if (numero === _ativo && _modoManual) { _modoManual = false; _atualizarModoBadge(false); }
    };
    document.addEventListener('wa:atendimento_devolvido', onDevolvido);
    _docListeners.push({ evt: 'wa:atendimento_devolvido', fn: onDevolvido });

    await _carregar();
    _pollTimer = setInterval(_carregar, 30_000);
  }

  function unmount(el) {
    clearInterval(_pollTimer);
    _pollTimer  = null;
    _ativo      = null;
    _modoManual = false;
    _busca      = '';
    // Remove document listeners
    for (const { evt, fn } of _docListeners) document.removeEventListener(evt, fn);
    _docListeners = [];
    _listaListener = null;
    if (el) { el.style.display = 'none'; el.classList.remove('active'); }
  }

  return { mount, unmount };
})();
