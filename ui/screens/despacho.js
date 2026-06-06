/**
 * Despacho — Kanban (Preparação → Aguardando Coleta → Em Rota) + Lista + Estornos
 * Fase 8 do CEIA OS
 */
const Despacho = (() => {
  function api(path) { return ((window.CEIA?.apiBase) || 'http://127.0.0.1:3000') + path; }

  // ── State ───────────────────────────────────────────────────────────────
  let _view        = 'kanban'; // 'kanban' | 'lista' | 'estornos'
  let _pedidos     = [];       // livres (preparacao sem pacote)
  let _pacotes     = [];       // pacotes ativos
  let _motoboys    = [];
  let _zonas       = [];
  let _produtos    = [];
  let _container   = null;
  let _dragId      = null;     // id do pedido sendo arrastado
  let _dragTimer   = null;

  // Saved .content overrides (like Zonas)
  let _contentPad  = null;
  let _contentOvf  = null;

  let _sse              = null;  // EventSource para eventos do bot
  let _sseConectado     = false; // true quando canal está OPEN
  let _reconcileTimer   = null;  // polling de reconciliação (safety net)

  // Alertas de acréscimo de item — persistem até confirmação manual do lojista
  // Cada pedido_alterado gera uma entrada independente; Ciente remove só a sua linha.
  let _alertasAcrescimo  = []; // [{ id, pedido_id, codigo, cliente_nome, item_novo, saiu_pacote }]
  let _alertasNextId     = 1;  // contador inteiro — evita colisão de float em data-attribute

  // List state
  let _listPage    = 0;
  const LIST_PER_PAGE = 50;
  let _listFilters = { busca: '', status: 'todos', origem: 'todos', data: 'hoje' };
  let _listTotal   = 0;
  let _listRows    = [];

  // ── Lifecycle ───────────────────────────────────────────────────────────
  function mount(container) {
    _container = container;
    container.style.display = 'block';
    // Full-height override
    const content = container.parentElement;
    if (content) {
      _contentPad = content.style.padding;
      _contentOvf = content.style.overflow;
      content.style.padding  = '32px 28px';
      content.style.overflow = 'hidden';
      content.style.display  = 'flex';
      content.style.flexDirection = 'column';
      container.style.flex   = '1';
      container.style.minHeight = '0';
    }
    _view = 'kanban';
    loadAndRender();
    startSSE();
    // Polling de reconciliação: rebusca estado a cada 15s enquanto a aba está ativa.
    // Cinto de segurança — corrige estado mesmo que um evento SSE seja perdido.
    _reconcileTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadAndRender();
    }, 15_000);
  }

  function unmount(container) {
    const content = container?.parentElement;
    if (content) {
      content.style.padding      = _contentPad ?? '';
      content.style.overflow     = _contentOvf ?? '';
      content.style.display      = '';
      content.style.flexDirection = '';
    }
    if (container) {
      container.style.flex       = '';
      container.style.minHeight  = '';
    }
    stopSSE();
    clearInterval(_reconcileTimer);
    _reconcileTimer   = null;
    _alertasAcrescimo = [];
    _alertasNextId    = 1;
    _container = null;
  }

  // ── SSE — eventos do kanban (aceite/recusa/baixa/coleta/finalização) ───────
  const _SSE_EVENTOS_KANBAN = new Set([
    'ACEITE_ROTA', 'RECUSA_ROTA', 'BAIXA_PEDIDO',
    'pacote_despachado', 'pacote_em_rota', 'pacote_finalizado',
    'pedido_criado', 'PEDIDO_PAGO', 'PEDIDO_CANCELADO',
    'pedido_alterado',
  ]);

  function _tocarAlertaAlteracao() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Dois bipes curtos ascendentes
      [0, 0.25].forEach((t, i) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(i === 0 ? 660 : 880, ctx.currentTime + t);
        gain.gain.setValueAtTime(0.35, ctx.currentTime + t);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.18);
      });
    } catch (_) {}
  }

  function startSSE() {
    stopSSE();
    try {
      _sseConectado = false;
      _sse = new EventSource(api('/api/eventos'));

      _sse.onopen = () => {
        if (_sseConectado) {
          // Reconectou após queda — rebusca estado para compensar eventos perdidos
          loadAndRender();
        }
        _sseConectado = true;
      };

      _sse.onmessage = e => {
        try {
          const d = JSON.parse(e.data);
          if (!_SSE_EVENTOS_KANBAN.has(d.tipo)) return;

          // Toasts informativos
          if (d.tipo === 'pedido_criado')
            window.Toast?.success(`🛒 Novo pedido WhatsApp! ${d.data?.cliente_nome ? '— ' + d.data.cliente_nome : ''}`);
          else if (d.tipo === 'PEDIDO_PAGO')
            window.Toast?.success(`✅ Pagamento confirmado! Pedido #${d.data?.codigo || ''} → Preparação`);
          else if (d.tipo === 'PEDIDO_CANCELADO')
            window.Toast?.info(`❌ Pedido #${d.data?.codigo || ''} cancelado/vencido`);
          else if (d.tipo === 'ACEITE_ROTA')  window.Toast?.info('✅ Rota aceita!');
          else if (d.tipo === 'RECUSA_ROTA')  window.Toast?.info('❌ Rota recusada');
          else if (d.tipo === 'BAIXA_PEDIDO') window.Toast?.info('📦 Entrega confirmada!');
          else if (d.tipo === 'pedido_alterado') {
            _tocarAlertaAlteracao();
            _alertasAcrescimo.push({
              id:           _alertasNextId++, // inteiro sequencial — comparação exata no data-attribute
              pedido_id:    d.data?.pedido_id   ?? null,
              codigo:       d.data?.codigo      || '',
              cliente_nome: d.data?.cliente_nome || '',
              item_novo:    d.data?.item_novo    || 'item',
              saiu_pacote:  !!d.data?.saiu_pacote,
            });
          }

          loadAndRender();
        } catch (_) {}
      };

      _sse.onerror = () => {
        // NÃO fechar — EventSource nativo reconecta automaticamente.
        // Só intervimos se definitivamente fechado (raro: 204/301 do servidor).
        if (_sse && _sse.readyState === EventSource.CLOSED) {
          _sseConectado = false;
          stopSSE();
          setTimeout(startSSE, 3000);
        }
      };
    } catch (_) {}
  }

  function stopSSE() {
    if (_sse) { try { _sse.close(); } catch (_) {} _sse = null; }
    _sseConectado = false;
  }

  // ── Data loading ─────────────────────────────────────────────────────
  async function loadAndRender() {
    try {
      const [livres, pacotes, motoboys, zonas] = await Promise.all([
        fetch(api('/api/pedidos/kanban')).then(r => r.json()).catch(() => []),
        fetch(api('/api/pacotes')).then(r => r.json()).catch(() => []),
        fetch(api('/api/motoboys')).then(r => r.json()).catch(() => []),
        fetch(api('/api/zonas')).then(r => r.json()).catch(() => []),
      ]);
      _pedidos  = Array.isArray(livres) ? livres : [];
      _pacotes  = Array.isArray(pacotes) ? pacotes : [];
      _motoboys = Array.isArray(motoboys) ? motoboys : [];
      _zonas    = Array.isArray(zonas) ? zonas : [];
    } catch(_) {}
    renderKanban();
  }

  // ── Render helpers ──────────────────────────────────────────────────
  function esc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtPreco(v) { return 'R$ ' + (+(v||0)).toFixed(2).replace('.',','); }
  function fmtData(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) + ' ' +
           dt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  }
  const STATUS_LABEL = {
    preparacao:'Preparação', aguardando_coleta:'Aguardando', em_rota:'Em rota',
    finalizado:'Finalizado', cancelado:'Cancelado', estornado:'Estornado',
  };

  // ── Zona color lookup ───────────────────────────────────────────────
  const ZONA_COR_NEUTRAL = '#6b7280'; // pedido sem zona identificada
  function _resolveZonaCor(bairroNome) {
    if (!bairroNome || !_zonas.length) return ZONA_COR_NEUTRAL;
    const norm = bairroNome.toLowerCase().trim();
    const zona = _zonas.find(z => (z.nome || '').toLowerCase().trim() === norm);
    return (zona && zona.cor) ? zona.cor : ZONA_COR_NEUTRAL;
  }

  // ── Kanban render ───────────────────────────────────────────────────
  function renderKanban() {
    if (!_container) return;
    // pedidos na col 1 = todos _pedidos (sem pacote, status=preparacao)
    const col1Cards  = _pedidos;
    const col2Pacs   = _pacotes.filter(p => p.status === 'montando' || p.status === 'aguardando' || p.status === 'aguardando_coleta');
    const col3Pacs   = _pacotes.filter(p => p.status === 'em_rota');

    const _bannerHtml = _alertasAcrescimo.length > 0 ? `
      <div class="dsp-alert-banner" id="dsp-alert-banner">
        ${_alertasAcrescimo.map(a => `
          <div class="dsp-alert-item">
            <span class="dsp-alert-msg">
              ⚠️ Pedido <strong>#${esc(a.codigo)}</strong>${a.cliente_nome ? ` (${esc(a.cliente_nome)})` : ''} alterado:
              <strong>+${esc(a.item_novo)}</strong>${a.saiu_pacote ? ' — voltou para Preparação' : ''}
            </span>
            <button class="dsp-alert-ok" data-dismiss-alert="${a.id}" data-pedido-id="${a.pedido_id ?? ''}">Ciente, vou re-preparar</button>
          </div>
        `).join('')}
      </div>` : '';

    _container.innerHTML = `
      <div class="dsp-root" id="dsp-root">
        ${_bannerHtml}
        <div class="dsp-bar">
          <span class="dsp-bar-title">Despacho</span>
          <div class="dsp-bar-actions">
            <button class="dsp-btn-ghost" id="dsp-btn-manual">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6.5" y1="1" x2="6.5" y2="12"/><line x1="1" y1="6.5" x2="12" y2="6.5"/></svg>
              Pedido manual
            </button>
            <button class="dsp-btn" id="dsp-btn-lista">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="3" x2="12" y2="3"/><line x1="1" y1="6.5" x2="12" y2="6.5"/><line x1="1" y1="10" x2="8" y2="10"/></svg>
              Lista completa
            </button>
          </div>
        </div>
        <div class="dsp-board" id="dsp-board">
          <!-- Col 1: Preparação -->
          <div class="dsp-col" id="dsp-col-1" data-col="1">
            <div class="dsp-col-header">
              <span>1. Preparação</span>
              <span class="dsp-col-count">${col1Cards.length}</span>
            </div>
            <div class="dsp-col-body" id="dsp-body-1">
              ${col1Cards.length ? col1Cards.map(renderCard).join('') : '<div class="dsp-empty">Nenhum pedido</div>'}
            </div>
          </div>
          <!-- Col 2: Aguardando Coleta -->
          <div class="dsp-col" id="dsp-col-2">
            <div class="dsp-col-header">
              <span>2. Aguardando Coleta</span>
              <button class="dsp-btn-ghost" id="dsp-btn-novo-pac" style="height:24px;padding:0 10px;font-size:11px">+ Pacote</button>
            </div>
            <div class="dsp-col-body" id="dsp-body-2">
              ${col2Pacs.length ? col2Pacs.map(renderPacote).join('') : '<div class="dsp-empty">Crie um pacote e arraste pedidos</div>'}
            </div>
          </div>
          <!-- Col 3: Em Rota -->
          <div class="dsp-col" id="dsp-col-3">
            <div class="dsp-col-header">
              <span>3. Em Rota</span>
              <span class="dsp-col-count">${col3Pacs.length}</span>
            </div>
            <div class="dsp-col-body" id="dsp-body-3">
              ${col3Pacs.length ? col3Pacs.map(renderPacoteRota).join('') : '<div class="dsp-empty">Nenhum pacote em rota</div>'}
            </div>
          </div>
        </div>
      </div>`;

    bindKanbanEvents();
  }

  function renderCard(p) {
    const itens    = tryParseItens(p.itens);
    const sub      = p.bairro || p.endereco?.split(',')[0] || '';
    const zonaCor  = _resolveZonaCor(p.bairro);
    return `
      <div class="kcard kcard-editable" draggable="true" data-id="${p.id}" data-status="${esc(p.status)}" style="border-left-color:${zonaCor}" title="Clique para editar">
        ${p.status === 'aguardando_pagamento' ? '<div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#f59e0b;margin-bottom:4px;padding:2px 6px;background:rgba(245,158,11,.12);border-radius:3px;display:inline-block">⏳ Aguardando pagamento</div>' : ''}
        <div class="kcard-preco">${fmtPreco(p.total)}</div>
        <div class="kcard-nome">${esc(p.cliente_nome||'Sem nome')}</div>
        <div class="kcard-sub">${esc(sub)}</div>
        <div class="kcard-meta">${esc(p.forma_pagamento||'')}${itens.length ? ` · ${itens.length} item(ns)` : ''} · ${fmtData(p.criado_em)}</div>
        ${p.observacoes ? `<div class="kcard-obs" style="font-size:11px;color:#e6a817;margin-top:3px;font-style:italic">📝 ${esc(p.observacoes)}</div>` : ''}
        <div class="kcard-actions">
          <button class="kcard-edit" data-edit-pedido="${p.id}" title="Editar">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5l1.5 1.5L3 9.5H1.5V8z"/><path d="M7 2.5l1.5 1.5"/></svg>
          </button>
          <button class="kcard-remove" data-remove-pedido="${p.id}" title="Remover pedido">×</button>
        </div>
      </div>`;
  }

  function renderPacote(pac) {
    const pedidos       = pac.pedidos || [];
    const picking       = pac.status === 'montando';
    const waiting       = pac.status === 'aguardando';
    const awaitingColeta = pac.status === 'aguardando_coleta';
    const num           = String(pac.id).padStart(3,'0');
    const itemsHtml = pedidos.map(p => `
      <div class="kpac-item" data-id="${p.id}" data-status="${esc(p.status)}" draggable="${picking ? 'true' : 'false'}" style="border-left-color:${_resolveZonaCor(p.bairro)}">
        <span class="kpac-item-nome">${esc(p.cliente_nome?.split(' ')[0]||'?')}</span>
        <span class="kpac-item-end">${esc(p.bairro||p.endereco?.split(',')[0]||'')}</span>
        <span style="font-size:11px;color:var(--teal);font-family:monospace;white-space:nowrap">${fmtPreco(p.total)}</span>
        <div class="kpac-item-btns">
          <button class="kpac-item-devolver" data-devolver-pedido="${p.id}" title="Devolver para Preparação">↩</button>
          ${picking ? `<button class="kpac-item-remove" data-remove-from-pac="${pac.id}" data-pedido-id="${p.id}" title="Tirar do pacote">×</button>` : ''}
        </div>
      </div>`).join('');

    const dropZone = picking ? `
      <div class="kpac-drop-zone${pedidos.length?'':' empty'}" data-drop-pac="${pac.id}">
        ${itemsHtml || 'Arraste pedidos aqui'}
      </div>` : `<div style="display:flex;flex-direction:column;gap:6px">${itemsHtml}</div>`;

    let statusLabel = '';
    if (waiting) {
      statusLabel = `
        <div class="kpac-motoboy">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="5.5" r="4.5"/><path d="M5.5 3v2.5l1.5 1.5"/></svg>
          Aguardando ${esc(pac.motoboy_nome||'motoboy')}
        </div>`;
    } else if (awaitingColeta) {
      statusLabel = `
        <div class="kpac-motoboy">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="5.5" r="2"/><path d="M1 10c0-2.5 2-4 4.5-4S10 7.5 10 10"/></svg>
          ${esc(pac.motoboy_nome||'Motoboy')} a caminho
        </div>`;
    }

    const deleteBtn = `<button class="dsp-icon-btn danger" data-delete-pac="${pac.id}" title="Excluir pacote">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="1 3 10 3"/><path d="M9 3v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3"/><path d="M7 3V2a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v1"/></svg>
            </button>`;

    let headerActions;
    if (picking) {
      headerActions = `${deleteBtn}<button class="dsp-btn" data-despachar-pac="${pac.id}" style="height:28px;font-size:11px;padding:0 10px">Despachar</button>`;
    } else if (awaitingColeta) {
      // Nuvem: aceite confirmado, aguardando coleta física no balcão
      headerActions = `${statusLabel}${deleteBtn}<button class="dsp-btn-ghost" data-confirmar-coleta="${pac.id}" style="height:28px;font-size:11px;padding:0 10px">Confirmar coleta</button>`;
    } else {
      // aguardando aceite (Nuvem pendente)
      headerActions = `${statusLabel}${deleteBtn}`;
    }

    return `
      <div class="kpac" data-pac-id="${pac.id}" data-status="${pac.status}">
        <div class="kpac-header">
          <span class="kpac-title">PACOTE #${num}</span>
          <div class="kpac-actions">
            ${headerActions}
          </div>
        </div>
        ${dropZone}
      </div>`;
  }

  function renderPacoteRota(pac) {
    const pedidos = pac.pedidos || [];
    const num     = String(pac.id).padStart(3,'0');
    return `
      <div class="kpac" data-pac-id="${pac.id}" data-status="em_rota">
        <div class="kpac-header">
          <span class="kpac-title en-route">EM ROTA #${num}</span>
          <button class="dsp-btn" data-finalizar-pac="${pac.id}" style="height:28px;font-size:11px;padding:0 10px;background:#10b981">Finalizar</button>
        </div>
        <div class="kpac-motoboy" style="margin-bottom:4px">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="5.5" cy="3" r="2"/><path d="M1 10c0-2.5 2-4 4.5-4S10 7.5 10 10"/></svg>
          ${esc(pac.motoboy_nome||'Motoboy')}
        </div>
        ${pedidos.map(p => `
          <div class="kpac-item" style="border-left-color:${_resolveZonaCor(p.bairro)}">
            <span class="kpac-item-nome">${esc(p.cliente_nome?.split(' ')[0]||'?')}</span>
            <span class="kpac-item-end">${esc(p.bairro||p.endereco?.split(',')[0]||'')}</span>
            <span style="font-size:11px;color:var(--teal);font-family:monospace">${fmtPreco(p.total)}</span>
          </div>`).join('')}
      </div>`;
  }

  // ── Kanban events ───────────────────────────────────────────────────
  function bindKanbanEvents() {
    const root = document.getElementById('dsp-root');
    if (!root) return;

    // Buttons
    document.getElementById('dsp-btn-manual')?.addEventListener('click', () => openNovoPedido());
    document.getElementById('dsp-btn-lista')?.addEventListener('click', () => { _view = 'lista'; renderListView(); });
    document.getElementById('dsp-btn-novo-pac')?.addEventListener('click', criarPacote);

    // Dismiss de alerta de acréscimo (banner fixo)
    document.getElementById('dsp-alert-banner')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-dismiss-alert]');
      if (!btn) return;
      const alertId  = Number(btn.dataset.dismissAlert);
      const pedidoId = btn.dataset.pedidoId || '';
      _alertasAcrescimo = _alertasAcrescimo.filter(a => a.id !== alertId);
      renderKanban();
      // Rola até o card do pedido na coluna Preparação após re-render
      if (pedidoId) {
        const card = document.querySelector(`[data-id="${pedidoId}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });

    // Event delegation
    root.addEventListener('click', e => {
      const el = e.target.closest('[data-remove-pedido]');
      if (el) return confirmarRemoverPedido(+el.dataset.removePedido);

      const rp = e.target.closest('[data-remove-from-pac]');
      if (rp) return tirarDoPacote(+rp.dataset.removeFromPac, +rp.dataset.pedidoId);

      const dv = e.target.closest('[data-devolver-pedido]');
      if (dv) return tirarDoPacote(null, +dv.dataset.devolverPedido);

      const ed = e.target.closest('[data-edit-pedido]');
      if (ed) return openEditarPedido(+ed.dataset.editPedido);

      const dp = e.target.closest('[data-delete-pac]');
      if (dp) return deletarPacote(+dp.dataset.deletePac);

      const disp = e.target.closest('[data-despachar-pac]');
      if (disp) return abrirPickerMotoboy(+disp.dataset.despacharPac);

      const col = e.target.closest('[data-confirmar-coleta]');
      if (col) return confirmarColeta(+col.dataset.confirmarColeta);

      const fin = e.target.closest('[data-finalizar-pac]');
      if (fin) return finalizarEntrega(+fin.dataset.finalizarPac);

      const card = e.target.closest('.kcard');
      if (card && !e.target.closest('button')) openEditarPedido(+card.dataset.id);
    });

    // Drag & drop — cards (col1 kcards) + kpac-items (col2 → col1)
    root.addEventListener('dragstart', e => {
      const card = e.target.closest('.kcard');
      const item = !card && e.target.closest('.kpac-item[draggable="true"]');
      const el   = card || item;
      if (!el) return;
      _dragId = +el.dataset.id;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _dragId);
    });

    root.addEventListener('dragend', e => {
      const el = e.target.closest('.kcard, .kpac-item');
      if (el) el.classList.remove('dragging');
      document.querySelectorAll('.drop-active').forEach(el => el.classList.remove('drop-active'));
    });

    // Col 1 as drop zone (retira do pacote)
    const col1 = document.getElementById('dsp-col-1');
    col1?.addEventListener('dragover', e => { e.preventDefault(); col1.classList.add('drop-active'); });
    col1?.addEventListener('dragleave', e => { if (!col1.contains(e.relatedTarget)) col1.classList.remove('drop-active'); });
    col1?.addEventListener('drop', e => {
      e.preventDefault();
      col1.classList.remove('drop-active');
      if (_dragId) dropToCol1(_dragId);
    });

    // Package drop zones
    root.addEventListener('dragover', e => {
      const zone = e.target.closest('[data-drop-pac]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('drop-active');
    });
    root.addEventListener('dragleave', e => {
      const zone = e.target.closest('[data-drop-pac]');
      if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-active');
    });
    root.addEventListener('drop', e => {
      const zone = e.target.closest('[data-drop-pac]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('drop-active');
      if (_dragId) dropToPacote(_dragId, +zone.dataset.dropPac);
    });
  }

  // ── Kanban actions ──────────────────────────────────────────────────
  async function dropToCol1(pedidoId) {
    // Remove do pacote que estava
    for (const pac of _pacotes) {
      const idx = (pac.pedidos||[]).findIndex(p => p.id === pedidoId);
      if (idx >= 0) {
        await fetch(api(`/api/pedidos/${pedidoId}`), {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ pacote_id: null, status: 'preparacao' }),
        }).catch(() => {});
        break;
      }
    }
    loadAndRender();
  }

  async function dropToPacote(pedidoId, pacoteId) {
    // Retira de qualquer outro pacote
    for (const pac of _pacotes) {
      if ((pac.pedidos||[]).find(p => p.id === pedidoId)) {
        await fetch(api(`/api/pedidos/${pedidoId}`), {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ pacote_id: null }),
        }).catch(() => {});
        break;
      }
    }
    await fetch(api(`/api/pedidos/${pedidoId}`), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pacote_id: pacoteId, status: 'aguardando_coleta' }),
    }).catch(() => {});
    loadAndRender();
  }

  async function criarPacote() {
    await fetch(api('/api/pacotes'), { method: 'POST' }).catch(() => {});
    loadAndRender();
  }

  async function tirarDoPacote(_pacoteId, pedidoId) {
    const r = await fetch(api(`/api/pedidos/${pedidoId}`), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pacote_id: null, status: 'preparacao' }),
    }).catch(() => null);
    if (r?.ok) window.Toast?.success('Pedido devolvido para Preparação');
    loadAndRender();
  }

  async function deletarPacote(pacoteId) {
    const pac = _pacotes.find(p => p.id === pacoteId);
    if (pac?.status === 'em_rota') {
      await window.Dialog?.alert({
        title: 'Pacote em rota',
        message: 'Este pacote está em rota e não pode ser excluído.\nCancele a rota primeiro.',
      });
      return;
    }
    const nPedidos = (pac?.pedidos || []).length;
    const ok = await window.Dialog?.confirm({
      title: `Excluir pacote #${String(pacoteId).padStart(3,'0')}?`,
      message: nPedidos
        ? `${nPedidos} pedido(s) voltarão para a coluna Preparação.`
        : 'O pacote está vazio.',
      confirmText: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    const r = await fetch(api(`/api/pacotes/${pacoteId}`), { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) {
      const data = await r?.json().catch(() => ({}));
      window.Toast?.error(data?.error || 'Erro ao excluir pacote');
      return;
    }
    window.Toast?.success('Pacote excluído');
    loadAndRender();
  }

  async function confirmarRemoverPedido(pedidoId) {
    const ok = await window.Dialog?.confirm({
      title: 'Excluir pedido?',
      message: 'Esta ação não pode ser desfeita.',
      confirmText: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await fetch(api(`/api/pedidos/${pedidoId}`), { method: 'DELETE' }).catch(() => {});
    loadAndRender();
  }

  // Motoboy picker — inline no pacote (substitui o botão "Despachar" pelo picker)
  function abrirPickerMotoboy(pacoteId) {
    const pacEl = document.querySelector(`[data-pac-id="${pacoteId}"]`);
    if (!pacEl) return;
    const actionsEl = pacEl.querySelector('.kpac-actions');
    if (!actionsEl) return;
    // Online = disponível para despacho; ativo = administrativamente ativo
    const ativos = _motoboys.filter(m =>
      m.status === 'ativo' && ['ONLINE', 'EM_ROTA'].includes(m.operacional_status)
    );
    if (!ativos.length) {
      return window.Toast?.error('Nenhum motoboy online. Peça para os motoboys ficarem online no app.');
    }
    actionsEl.innerHTML = `
      <div class="kpac-picker">
        <div class="kpac-picker-label">Escolher motoboy</div>
        <div class="kpac-picker-list">
          ${ativos.map(m => `
            <button class="kpac-picker-btn" data-pick-motoboy="${m.id}" data-pac="${pacoteId}">
              ${esc(m.nome)}
            </button>`).join('')}
        </div>
        <button class="kpac-picker-cancel" data-cancel-pick="${pacoteId}">Cancelar</button>
      </div>`;

    // Bind
    actionsEl.querySelectorAll('[data-pick-motoboy]').forEach(btn => {
      btn.addEventListener('click', () => despacharPacote(pacoteId, +btn.dataset.pickMotoboy));
    });
    actionsEl.querySelector('[data-cancel-pick]')?.addEventListener('click', renderKanban);
  }

  async function despacharPacote(pacoteId, motoboyId) {
    const r = await fetch(api('/api/operacao/despachar'), {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pacote_id: pacoteId, motoboy_id: motoboyId }),
    }).catch(() => null);
    if (r?.ok) {
      const data = await r.json().catch(() => ({}));
      if (data.telegram_notified) {
        window.Toast?.success('Pacote despachado! 🛵 Rota enviada no Telegram');
      } else if (data.telegram_msg) {
        window.Toast?.success('Pacote despachado!');
        window.Toast?.warn(`Telegram: ${data.telegram_msg}`);
      } else {
        window.Toast?.success('Pacote despachado!');
      }
      loadAndRender();
    } else {
      window.Toast?.error('Erro ao despachar pacote');
    }
  }

  async function confirmarColeta(pacoteId) {
    const ok = await window.Dialog?.confirm({
      title: 'Confirmar coleta',
      message: 'O motoboy já coletou este pacote?',
      confirmText: 'Sim, coletou',
    });
    if (!ok) return;
    const r = await fetch(api('/api/operacao/confirmar-coleta'), {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pacote_id: pacoteId }),
    }).catch(() => null);
    if (r?.ok) {
      window.Toast?.success('Pacote em rota!');
      loadAndRender();
    } else {
      window.Toast?.error('Erro ao confirmar coleta');
    }
  }

  async function finalizarEntrega(pacoteId) {
    const ok = await window.Dialog?.confirm({
      title: 'Finalizar entregas',
      message: 'Confirmar finalização de todas as entregas deste pacote?',
      confirmText: 'Finalizar',
    });
    if (!ok) return;
    const r = await fetch(api('/api/operacao/finalizar-entrega'), {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ pacote_id: pacoteId }),
    }).catch(() => null);
    if (r?.ok) {
      window.Toast?.success('Entrega(s) finalizada(s)!');
      loadAndRender();
    } else {
      window.Toast?.error('Erro ao finalizar entrega');
    }
  }

  // ── Detalhes do pedido (drawer) ─────────────────────────────────────
  async function openDetalhesPedido(pedidoId) {
    // Busca pedido atualizado
    const r = await fetch(api(`/api/pedidos?busca=${pedidoId}&limit=1`)).catch(() => null);
    const data = r?.ok ? await r.json() : null;
    const pedido = data?.rows?.[0] || _pedidos.find(p => p.id === pedidoId) ||
      _pacotes.flatMap(pac => pac.pedidos||[]).find(p => p.id === pedidoId);
    if (!pedido) return;

    const itens = tryParseItens(pedido.itens);
    const backdrop = document.createElement('div');
    backdrop.className = 'dsp-drawer-backdrop';
    const drawer = document.createElement('div');
    drawer.className = 'dsp-drawer';
    drawer.innerHTML = `
      <div class="dsp-drawer-header">
        <span class="dsp-drawer-title">Pedido #${esc(pedido.codigo)}</span>
        <button class="dsp-icon-btn" id="dsp-det-close">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="12" y2="12"/><line x1="12" y1="1" x2="1" y2="12"/></svg>
        </button>
      </div>
      <div class="dsp-drawer-body">
        <div>
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Cliente</div>
          <div style="font-size:14px;font-weight:600;color:var(--text)">${esc(pedido.cliente_nome||'—')}</div>
          ${pedido.cliente_whatsapp ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(pedido.cliente_whatsapp)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Endereço</div>
          <div style="font-size:13px;color:var(--text)">${esc(pedido.endereco||'—')}</div>
          ${pedido.bairro ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${esc(pedido.bairro)}</div>` : ''}
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Itens (${itens.length})</div>
          ${itens.map(it => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:13px;color:var(--text)">${esc(it.qtd||1)}× ${esc(it.nome||it.name||'Item')}</span>
              <span style="font-family:monospace;font-size:12px;color:var(--teal)">${fmtPreco((it.preco||it.price||it.preco_unit||0)*(it.qtd||it.quantidade||1))}</span>
            </div>`).join('') || '<div style="font-size:12px;color:var(--text-dim)">Sem itens registrados</div>'}
        </div>
        <div class="dsp-totais">
          <div class="dsp-total-row"><span>Subtotal</span><span>${fmtPreco(pedido.subtotal)}</span></div>
          <div class="dsp-total-row"><span>Taxa de entrega</span><span>${fmtPreco(pedido.taxa_entrega)}</span></div>
          <div class="dsp-total-row grand"><span>Total</span><span>${fmtPreco(pedido.total)}</span></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px">
          <div>
            <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Pagamento</div>
            <div style="font-size:13px;color:var(--text)">${esc(pedido.forma_pagamento||'—')}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Status</div>
            <span class="dsp-status-pill ${esc(pedido.status)}">${esc(STATUS_LABEL[pedido.status]||pedido.status)}</span>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Origem</div>
            <div style="font-size:13px;color:var(--text)">${esc(pedido.origem||'manual')}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Criado em</div>
            <div style="font-size:12px;color:var(--text-muted)">${fmtData(pedido.criado_em)}</div>
          </div>
        </div>
      </div>
      <div class="dsp-drawer-footer">
        <button class="dsp-btn-ghost" id="dsp-det-close2">Fechar</button>
      </div>`;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    const close = () => { backdrop.remove(); drawer.remove(); onEsc && document.removeEventListener('keydown', onEsc); };
    const onEsc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    backdrop.addEventListener('click', close);
    drawer.querySelector('#dsp-det-close')?.addEventListener('click', close);
    drawer.querySelector('#dsp-det-close2')?.addEventListener('click', close);
  }

  // ── Pedido manual / edição ────────────────────────────────────────────
  async function openEditarPedido(pedidoId) {
    // Busca o pedido mais recente
    const pedido = _pedidos.find(p => p.id === pedidoId) ||
      _pacotes.flatMap(pac => pac.pedidos||[]).find(p => p.id === pedidoId);
    if (!pedido) return;
    openNovoPedido(pedido);
  }

  async function openNovoPedido(existingPedido = null) {
    const isEdit = !!existingPedido;
    // Carrega produtos com variações se ainda não temos
    if (!_produtos.length) {
      _produtos = await fetch(api('/api/produtos/todos')).then(r => r.json()).catch(() => []);
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'dsp-drawer-backdrop';
    const drawer = document.createElement('div');
    drawer.className = 'dsp-drawer';

    // Pré-popula itens se editando — preserva produto_id, variacao, adicionais
    let itens = isEdit ? tryParseItens(existingPedido.itens).map(it => ({
      nome:       it.nome || it.name || 'Item',
      preco:      it.preco || it.price || it.preco_unit || 0,
      qtd:        it.qtd || it.quantity || it.quantidade || 1,
      produto_id: it.produto_id || null,
      variacao:   it.variacao || null,
      adicionais: Array.isArray(it.adicionais) ? it.adicionais : [],
    })) : [];
    let _placeLat = existingPedido?.lat ?? null;
    let _placeLng = existingPedido?.lng ?? null;

    const zonaOpts = _zonas.map(z => `<option value="${esc(z.nome)}" data-taxa="${z.taxa}">${esc(z.nome)} (+${fmtPreco(z.taxa)})</option>`).join('');

    // zona detectada automaticamente — mantida em estado local (não num select visível)
    let _zonaBairro = null; // nome da zona para salvar no pedido

    const renderDrawer = () => {
      const subtotal = itens.reduce((a, it) => a + it.preco * it.qtd, 0);
      const taxa     = +(drawer.querySelector('#dsp-m-taxa')?.value || 0);
      const total    = subtotal + taxa;
      drawer.querySelector('#dsp-m-itens-list').innerHTML = itens.map((it, i) => `
        <div class="dsp-item-row">
          <button class="dsp-item-dec" data-item-dec="${i}" style="width:22px;height:22px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:2px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center">−</button>
          <span class="dsp-item-qtd" style="min-width:18px;text-align:center;font-size:13px">${it.qtd}</span>
          <button class="dsp-item-inc" data-item-inc="${i}" style="width:22px;height:22px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:2px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center">+</button>
          <span class="dsp-item-nome" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.nome)}</span>
          <span class="dsp-item-preco">${fmtPreco(it.preco*it.qtd)}</span>
          <button class="dsp-item-rm" data-item-rm="${i}">×</button>
        </div>`).join('') || '<div style="font-size:12px;color:var(--text-dim)">Nenhum item</div>';
      const subtEl = drawer.querySelector('#dsp-m-subtotal'); if(subtEl) subtEl.textContent = fmtPreco(subtotal);
      const totEl  = drawer.querySelector('#dsp-m-total');   if(totEl)  totEl.textContent  = fmtPreco(total);
    };

    // Monta a área de zona dinamicamente
    const setZonaUI = (mode, zona) => {
      const area = drawer.querySelector('#dsp-m-zona-area');
      if (!area) return;
      if (mode === 'found') {
        // Caminho feliz — linha informativa, sem select
        _zonaBairro = zona.nome;
        const taxaInput = drawer.querySelector('#dsp-m-taxa');
        if (taxaInput) taxaInput.value = zona.taxa ?? 0;
        area.innerHTML = `
          <div style="font-size:12px;color:#4ade80;letter-spacing:-0.01em;padding:6px 0 2px">
            ✓ Zona: <strong style="font-weight:600">${esc(zona.nome)}</strong> — taxa ${fmtPreco(zona.taxa)}
          </div>`;
        renderDrawer();
      } else {
        // Caminho de exceção — aviso âmbar + select fallback
        _zonaBairro = null;
        const taxaInput = drawer.querySelector('#dsp-m-taxa');
        if (taxaInput) taxaInput.value = 0;
        area.innerHTML = `
          <div style="font-size:12px;color:#f59e0b;letter-spacing:-0.01em;padding:6px 0 6px">
            ⚠ Endereço fora das zonas cadastradas
          </div>
          <label class="dsp-form-label" style="margin-bottom:4px">Aplicar zona manualmente:</label>
          <select id="dsp-m-bairro-fallback" class="dsp-form-select">
            <option value="" data-taxa="0">Sem taxa de entrega</option>
            ${zonaOpts}
          </select>`;
        // bind fallback select
        area.querySelector('#dsp-m-bairro-fallback')?.addEventListener('change', e => {
          const opt = e.target.selectedOptions[0];
          _zonaBairro = opt?.value || null;
          const taxaInput = drawer.querySelector('#dsp-m-taxa');
          if (taxaInput) taxaInput.value = opt?.dataset?.taxa || 0;
          renderDrawer();
        });
        renderDrawer();
      }
    };

    const ep = existingPedido;
    drawer.innerHTML = `
      <div class="dsp-drawer-header">
        <span class="dsp-drawer-title">${isEdit ? `Editar Pedido #${esc(ep.codigo||ep.id)}` : 'Novo pedido manual'}</span>
        <button class="dsp-icon-btn" id="dsp-m-close">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="12" y2="12"/><line x1="12" y1="1" x2="1" y2="12"/></svg>
        </button>
      </div>
      <div class="dsp-drawer-body" id="dsp-m-body">
        <div class="dsp-form-row">
          <label class="dsp-form-label">Nome do cliente</label>
          <input id="dsp-m-nome" class="dsp-form-input" type="text" placeholder="Ex: João da Silva" value="${esc(ep?.cliente_nome||'')}">
        </div>
        <div class="dsp-form-row">
          <label class="dsp-form-label">WhatsApp</label>
          <input id="dsp-m-fone" class="dsp-form-input" type="text" placeholder="(XX) XXXXX-XXXX" value="${esc(ep?.cliente_whatsapp||'')}">
        </div>
        <div class="dsp-form-row">
          <label class="dsp-form-label">Endereço</label>
          <input id="dsp-m-end" class="dsp-form-input" type="text" placeholder="Rua, número" value="${esc(ep?.endereco_formatado||ep?.endereco||'')}">
        </div>
        <div id="dsp-m-zona-area"></div>
        <div class="dsp-form-row">
          <label class="dsp-form-label">Complemento</label>
          <input id="dsp-m-comp" class="dsp-form-input" type="text" placeholder="Apto, bloco..." value="${esc(ep?.complemento||'')}">
        </div>

        <div style="border-top:1px solid var(--border);padding-top:14px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:8px">Itens</div>
          <div style="position:relative;margin-bottom:8px">
            <input id="dsp-m-busca-prod" class="dsp-form-input" type="text" placeholder="Buscar item do cardápio..." autocomplete="off" style="width:100%">
            <div id="dsp-m-prod-drop" style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:2px;background:var(--surface);border:1px solid var(--border);border-radius:4px;box-shadow:0 8px 24px rgba(0,0,0,.5);z-index:9999;max-height:220px;overflow-y:auto"></div>
          </div>
          <div id="dsp-m-var-picker" style="display:none"></div>
          <div class="dsp-itens-list" id="dsp-m-itens-list"></div>
        </div>

        <div class="dsp-form-row">
          <label class="dsp-form-label">Forma de pagamento</label>
          <select id="dsp-m-pgto" class="dsp-form-select">
            ${['Dinheiro','PIX','Cartão'].map(o => `<option${ep?.forma_pagamento===o?' selected':''}>${o}</option>`).join('')}
          </select>
        </div>

        <div class="dsp-totais">
          <div class="dsp-total-row"><span>Subtotal</span><span id="dsp-m-subtotal">R$ 0,00</span></div>
          <div class="dsp-total-row"><span>Taxa de entrega</span><input id="dsp-m-taxa" type="number" value="${ep?.taxa_entrega??0}" min="0" step="0.01" style="width:80px;height:24px;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:0 6px;font-size:12px;text-align:right;outline:none;border-radius:2px"></div>
          <div class="dsp-total-row grand"><span>Total</span><span id="dsp-m-total">R$ 0,00</span></div>
        </div>
      </div>
      <div class="dsp-drawer-footer">
        <button class="dsp-btn-ghost" id="dsp-m-cancel">Cancelar</button>
        <button class="dsp-btn" id="dsp-m-salvar">${isEdit ? 'Salvar alterações' : 'Criar pedido'}</button>
      </div>`;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    // Pré-preenche zona quando editando
    if (isEdit && ep.bairro) {
      const zona = _zonas.find(z => z.nome === ep.bairro);
      if (zona) {
        _zonaBairro = zona.nome;
        const area = drawer.querySelector('#dsp-m-zona-area');
        if (area) area.innerHTML = `
          <div style="font-size:12px;color:#4ade80;letter-spacing:-0.01em;padding:6px 0 2px">
            ✓ Zona: <strong style="font-weight:600">${esc(zona.nome)}</strong> — taxa ${fmtPreco(zona.taxa)}
          </div>`;
      }
    }

    renderDrawer();

    const close = () => { backdrop.remove(); drawer.remove(); onEscEdit && document.removeEventListener('keydown', onEscEdit); };
    const onEscEdit = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEscEdit);
    backdrop.addEventListener('click', close);
    drawer.querySelector('#dsp-m-close')?.addEventListener('click', close);
    drawer.querySelector('#dsp-m-cancel')?.addEventListener('click', close);

    // ── Google Places Autocomplete (silently skipped if Maps not available) ──
    window.CeiaGMaps?.load().then(() => {
      const endInput = drawer.querySelector('#dsp-m-end');
      if (!endInput || !window.google?.maps?.places) return;
      const ac = new google.maps.places.Autocomplete(endInput, {
        componentRestrictions: { country: 'br' },
        fields: ['formatted_address', 'geometry', 'address_components'],
      });
      ac.addListener('place_changed', async () => {
        const place = ac.getPlace();
        if (!place?.geometry) return;
        _placeLat = place.geometry.location.lat();
        _placeLng = place.geometry.location.lng();
        endInput.value = place.formatted_address || endInput.value;

        // Lookup zona via backend (point-in-polygon + haversine)
        try {
          const r = await fetch(api(`/api/zonas/lookup?lat=${_placeLat}&lng=${_placeLng}`));
          if (r.ok) {
            const data = await r.json();
            if (data?.encontrada && data.zona) {
              setZonaUI('found', data.zona);
            } else {
              setZonaUI('notfound');
            }
          } else {
            setZonaUI('notfound');
          }
        } catch (_) {
          setZonaUI('notfound');
        }
      });
    }).catch(() => { /* sem autocomplete — campo funciona como text normal */ });

    drawer.querySelector('#dsp-m-taxa')?.addEventListener('input', renderDrawer);

    // ── Autocomplete de produtos ─────────────────────────────────────────────
    const buscaInput = drawer.querySelector('#dsp-m-busca-prod');
    const prodDrop   = drawer.querySelector('#dsp-m-prod-drop');
    const varPicker  = drawer.querySelector('#dsp-m-var-picker');

    // Normaliza string para busca (remove acentos, lowercase)
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    let _acItems  = []; // sugestões filtradas atuais
    let _acActive = -1; // índice da sugestão destacada

    function closeDrop() {
      prodDrop.style.display = 'none';
      _acItems  = [];
      _acActive = -1;
    }

    function renderDrop(items) {
      _acItems  = items;
      _acActive = -1;
      if (!items.length) { closeDrop(); return; }
      prodDrop.innerHTML = items.slice(0, 8).map((p, i) => {
        const precoLabel = p.tem_variacoes && p.preco_min_var != null
          ? `<span style="color:var(--text-dim);font-size:10px">a partir de</span> ${fmtPreco(p.preco_min_var)}`
          : fmtPreco(p.preco);
        const esg = p.esgotado ? ' <span style="color:#ef4444;font-size:10px">esgotado</span>' : '';
        return `<div class="dsp-ac-item" data-ac-idx="${i}" style="padding:8px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--text)">${esc(p.nome)}${esg}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${esc(p.categoria_nome||'')}</div>
          </div>
          <div style="font-size:12px;color:var(--text);white-space:nowrap;text-align:right">${precoLabel}</div>
        </div>`;
      }).join('');
      // remove border do último
      const last = prodDrop.lastElementChild;
      if (last) last.style.borderBottom = 'none';
      prodDrop.style.display = 'block';
    }

    function setActive(idx) {
      const rows = prodDrop.querySelectorAll('.dsp-ac-item');
      rows.forEach(r => r.style.background = '');
      _acActive = Math.max(-1, Math.min(idx, rows.length - 1));
      if (_acActive >= 0) {
        rows[_acActive].style.background = 'rgba(255,255,255,0.06)';
        rows[_acActive].scrollIntoView({ block: 'nearest' });
      }
    }

    // adicionaisArr = [{nome, preco}] — opções selecionadas dos grupos de adicionais
    function addItem(prod, varNome, varPreco, adicionaisArr) {
      adicionaisArr = adicionaisArr || [];
      const parts   = [varNome, ...adicionaisArr.map(a => a.nome)].filter(Boolean);
      const nome    = parts.length ? `${prod.nome} (${parts.join(', ')})` : prod.nome;
      const adicsPreco = adicionaisArr.reduce((s, a) => s + (+(a.preco) || 0), 0);
      const preco   = (varPreco != null ? varPreco : prod.preco) + adicsPreco;
      const existing = itens.find(it => it.nome === nome);
      if (existing) { existing.qtd += 1; }
      else itens.push({
        nome,
        preco,
        qtd:        1,
        produto_id: prod.id || null,
        variacao:   varNome || null,
        adicionais: adicionaisArr.map(a => a.nome),
      });
      renderDrawer();
    }

    function showPicker(prod) {
      const hasVars  = prod.tem_variacoes && prod.variacoes?.length;
      const hasAdics = prod.adicionais?.length;

      // Products with ONLY variações and NO adicionais: keep fast click-to-add behavior
      if (hasVars && !hasAdics) {
        varPicker.style.display = 'block';
        varPicker.innerHTML = `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 12px;margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:8px">Tamanho — ${esc(prod.nome)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px" id="dsp-var-opts">
              ${prod.variacoes.map((v,i) => `
                <button class="dsp-var-btn" data-var-idx="${i}"
                  style="padding:5px 10px;font-size:12px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;cursor:pointer">
                  ${esc(v.nome)} — ${fmtPreco(v.preco)}
                </button>`).join('')}
            </div>
            <button id="dsp-var-cancel" style="margin-top:8px;font-size:11px;color:var(--text-dim);background:none;border:none;cursor:pointer;padding:0">cancelar</button>
          </div>`;
        varPicker.querySelector('#dsp-var-cancel')?.addEventListener('click', () => {
          varPicker.style.display = 'none'; varPicker.innerHTML = ''; buscaInput.focus();
        });
        varPicker.querySelector('#dsp-var-opts')?.addEventListener('click', e => {
          const btn = e.target.closest('[data-var-idx]');
          if (!btn) return;
          const v = prod.variacoes[+btn.dataset.varIdx];
          if (!v) return;
          addItem(prod, v.nome, v.preco, []);
          varPicker.style.display = 'none'; varPicker.innerHTML = '';
          buscaInput.value = ''; buscaInput.focus();
        });
        return;
      }

      // Combined picker: variações (radio) + adicionais (checkboxes) + Confirmar
      let selectedVarIdx = hasVars ? null : -1; // null = nenhuma escolhida ainda

      let html = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:10px 12px;margin-bottom:8px">`;

      if (hasVars) {
        html += `
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:6px">Tamanho — ${esc(prod.nome)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px" id="dsp-var-opts">
            ${prod.variacoes.map((v,i) => `
              <button class="dsp-var-btn" data-var-idx="${i}"
                style="padding:5px 10px;font-size:12px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;cursor:pointer;transition:all .1s">
                ${esc(v.nome)} — ${fmtPreco(v.preco)}
              </button>`).join('')}
          </div>`;
      }

      if (hasAdics) {
        html += prod.adicionais.map(grupo => `
          <div style="margin-bottom:10px">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:5px">${esc(grupo.nome)}</div>
            <div style="display:flex;flex-direction:column;gap:3px">
              ${grupo.opcoes.map((op, oi) => `
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text);padding:2px 0">
                  <input type="checkbox" data-op-nome="${esc(op.nome)}" data-op-preco="${op.preco}"
                    style="accent-color:var(--teal);width:13px;height:13px">
                  ${esc(op.nome)}${op.preco > 0 ? ` <span style="color:var(--text-dim);font-size:11px">+${fmtPreco(op.preco)}</span>` : ''}
                </label>`).join('')}
            </div>
          </div>`).join('');
      }

      html += `
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="dsp-picker-confirm" style="flex:1;padding:6px 0;font-size:12px;font-weight:600;background:var(--teal);border:none;color:#000;border-radius:3px;cursor:pointer">Adicionar</button>
          <button id="dsp-var-cancel" style="padding:6px 10px;font-size:11px;color:var(--text-dim);background:none;border:1px solid var(--border);border-radius:3px;cursor:pointer">cancelar</button>
        </div>
      </div>`;

      varPicker.innerHTML = html;
      varPicker.style.display = 'block';

      const highlightVar = idx => {
        selectedVarIdx = idx;
        varPicker.querySelectorAll('.dsp-var-btn').forEach((b, i) => {
          const on = i === idx;
          b.style.background   = on ? 'var(--teal)' : 'var(--bg)';
          b.style.color        = on ? '#000'         : 'var(--text)';
          b.style.borderColor  = on ? 'var(--teal)'  : 'var(--border)';
        });
      };

      varPicker.querySelector('#dsp-var-opts')?.addEventListener('click', e => {
        const btn = e.target.closest('[data-var-idx]');
        if (btn) highlightVar(+btn.dataset.varIdx);
      });

      varPicker.querySelector('#dsp-picker-confirm')?.addEventListener('click', () => {
        if (hasVars && selectedVarIdx === null) {
          // Flash var section to indicate selection required
          const varOpts = varPicker.querySelector('#dsp-var-opts');
          if (varOpts) {
            varOpts.style.outline = '1px solid #ef4444';
            setTimeout(() => { if (varOpts) varOpts.style.outline = ''; }, 900);
          }
          return;
        }
        const v = (hasVars && selectedVarIdx >= 0) ? prod.variacoes[selectedVarIdx] : null;
        const selectedAdics = [];
        varPicker.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
          selectedAdics.push({ nome: cb.dataset.opNome, preco: +(cb.dataset.opPreco || 0) });
        });
        addItem(prod, v?.nome || null, v?.preco ?? null, selectedAdics);
        varPicker.style.display = 'none'; varPicker.innerHTML = '';
        buscaInput.value = ''; buscaInput.focus();
      });

      varPicker.querySelector('#dsp-var-cancel')?.addEventListener('click', () => {
        varPicker.style.display = 'none'; varPicker.innerHTML = ''; buscaInput.focus();
      });
    }

    function selectProd(prod) {
      closeDrop();
      if ((prod.tem_variacoes && prod.variacoes?.length) || prod.adicionais?.length) {
        showPicker(prod);
      } else {
        addItem(prod, null, null, []);
        buscaInput.value = '';
        buscaInput.focus();
      }
    }

    buscaInput?.addEventListener('input', () => {
      const q = norm(buscaInput.value.trim());
      if (!q) { closeDrop(); return; }
      const hits = _produtos.filter(p => norm(p.nome).includes(q));
      renderDrop(hits);
    });

    buscaInput?.addEventListener('keydown', e => {
      if (prodDrop.style.display === 'none') return;
      if (e.key === 'ArrowDown')  { e.preventDefault(); setActive(_acActive + 1); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(_acActive - 1); }
      else if (e.key === 'Enter')     { e.preventDefault(); if (_acActive >= 0) selectProd(_acItems[_acActive]); }
      else if (e.key === 'Escape')    { closeDrop(); }
    });

    prodDrop?.addEventListener('mousedown', e => {
      const row = e.target.closest('[data-ac-idx]');
      if (!row) return;
      e.preventDefault(); // evita blur antes do click
      selectProd(_acItems[+row.dataset.acIdx]);
    });

    prodDrop?.addEventListener('mouseover', e => {
      const row = e.target.closest('[data-ac-idx]');
      if (row) setActive(+row.dataset.acIdx);
    });

    // Fecha dropdown ao clicar fora
    document.addEventListener('click', function onDocClick(e) {
      if (!drawer.contains(e.target)) { closeDrop(); document.removeEventListener('click', onDocClick); }
    });

    // Itens events (delegated)
    drawer.querySelector('#dsp-m-itens-list')?.addEventListener('click', e => {
      const rm   = e.target.closest('[data-item-rm]');
      const dec  = e.target.closest('[data-item-dec]');
      const inc  = e.target.closest('[data-item-inc]');
      if (rm)  { itens.splice(+rm.dataset.itemRm, 1); renderDrawer(); }
      if (dec) { const i = +dec.dataset.itemDec; if (itens[i].qtd > 1) itens[i].qtd--; else itens.splice(i,1); renderDrawer(); }
      if (inc) { itens[+inc.dataset.itemInc].qtd++; renderDrawer(); }
    });

    // Salvar
    drawer.querySelector('#dsp-m-salvar')?.addEventListener('click', async () => {
      const nome = drawer.querySelector('#dsp-m-nome')?.value.trim();
      if (!nome) return window.Toast?.error('Informe o nome do cliente');
      const subtotal = itens.reduce((a, it) => a + it.preco * it.qtd, 0);
      const taxa     = +(drawer.querySelector('#dsp-m-taxa')?.value || 0);
      const body = {
        cliente_nome:     nome,
        cliente_whatsapp: drawer.querySelector('#dsp-m-fone')?.value.trim() || null,
        endereco:         drawer.querySelector('#dsp-m-end')?.value.trim() || '',
        bairro:           _zonaBairro || null,
        complemento:      drawer.querySelector('#dsp-m-comp')?.value.trim() || null,
        itens:            itens,
        subtotal,
        taxa_entrega:     taxa,
        total:            subtotal + taxa,
        forma_pagamento:  drawer.querySelector('#dsp-m-pgto')?.value || 'Dinheiro',
        origem:           'manual',
        status:           'preparacao',
        lat:              _placeLat,
        lng:              _placeLng,
      };
      const url    = isEdit ? api(`/api/pedidos/${existingPedido.id}`) : api('/api/pedidos');
      const method = isEdit ? 'PATCH' : 'POST';
      if (!isEdit) { body.origem = 'manual'; body.status = 'preparacao'; }
      const r = await fetch(url, {
        method, headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      }).catch(() => null);
      if (r?.ok) {
        if (!isEdit) {
          const novoPedido = await r.json().catch(() => null);
          const codigoInfo = novoPedido?.codigo_entrega ? ` — Código de entrega: ${novoPedido.codigo_entrega}` : '';
          window.Toast?.success(`Pedido criado!${codigoInfo}`);
        } else {
          window.Toast?.success('Pedido atualizado!');
        }
        close();
        loadAndRender();
      } else {
        window.Toast?.error(isEdit ? 'Erro ao salvar alterações' : 'Erro ao criar pedido');
      }
    });
  }

  // ── Lista completa ───────────────────────────────────────────────────
  async function renderListView() {
    if (!_container) return;
    await loadListData();
    _container.innerHTML = `
      <div class="dsp-list-root">
        <div class="dsp-list-bar">
          <button class="dsp-btn-ghost" id="dsp-back-kanban">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="8 1 2 6.5 8 12"/></svg>
            Voltar ao kanban
          </button>
          <button class="dsp-btn-ghost" id="dsp-btn-estornos">
            Histórico de Estornos
          </button>
        </div>
        <div class="dsp-filter-bar">
          <input class="dsp-search" id="dsp-busca" placeholder="Buscar por código, nome, WhatsApp..." value="${esc(_listFilters.busca)}">
          <select class="dsp-filter-select" id="dsp-fil-status">
            ${[['todos','Todos os status'],['preparacao','Preparação'],['aguardando_coleta','Aguardando'],['em_rota','Em rota'],['finalizado','Finalizado'],['cancelado','Cancelado'],['estornado','Estornado']].map(([v,l]) =>
              `<option value="${v}" ${_listFilters.status===v?'selected':''}>${l}</option>`).join('')}
          </select>
          <select class="dsp-filter-select" id="dsp-fil-origem">
            ${[['todos','Todas origens'],['manual','Manual'],['whatsapp','WhatsApp'],['vitrine','Vitrine']].map(([v,l]) =>
              `<option value="${v}" ${_listFilters.origem===v?'selected':''}>${l}</option>`).join('')}
          </select>
          <select class="dsp-filter-select" id="dsp-fil-data">
            ${[['hoje','Hoje'],['7d','7 dias'],['30d','30 dias'],['todos','Todos']].map(([v,l]) =>
              `<option value="${v}" ${_listFilters.data===v?'selected':''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="dsp-table-wrap">
          <table class="dsp-table">
            <thead><tr>
              <th>Código</th><th>Cliente</th><th>Total</th>
              <th>Pagamento</th><th>Status</th><th>Data</th><th></th>
            </tr></thead>
            <tbody id="dsp-tbody">${renderTbody()}</tbody>
          </table>
        </div>
        <div class="dsp-pagination">
          <span id="dsp-pag-info"></span>
          <div class="dsp-pagination-btns">
            <button class="dsp-btn-ghost" id="dsp-pag-prev" style="height:28px;font-size:11px;padding:0 10px">← Anterior</button>
            <button class="dsp-btn-ghost" id="dsp-pag-next" style="height:28px;font-size:11px;padding:0 10px">Próximo →</button>
          </div>
        </div>
      </div>`;

    updatePaginationInfo();
    bindListEvents();
  }

  function renderTbody() {
    if (!_listRows.length) return `<tr><td colspan="7"><div class="dsp-empty">Nenhum pedido encontrado</div></td></tr>`;
    return _listRows.map(p => `
      <tr data-pedido-id="${p.id}" style="cursor:pointer">
        <td class="td-code">#${esc(p.codigo)}</td>
        <td class="td-nome">${esc(p.cliente_nome||'—')}</td>
        <td class="td-total">${fmtPreco(p.total)}</td>
        <td>${esc(p.forma_pagamento||'—')}</td>
        <td><span class="dsp-status-pill ${esc(p.status)}">${esc(STATUS_LABEL[p.status]||p.status)}</span></td>
        <td style="font-size:12px;white-space:nowrap">${fmtData(p.criado_em)}</td>
        <td><button class="dsp-row-menu-btn" data-menu-pedido="${p.id}">⋮</button></td>
      </tr>`).join('');
  }

  function updatePaginationInfo() {
    const info = document.getElementById('dsp-pag-info');
    if (!info) return;
    const from = _listPage * LIST_PER_PAGE + 1;
    const to   = Math.min((_listPage + 1) * LIST_PER_PAGE, _listTotal);
    info.textContent = _listTotal ? `${from}–${to} de ${_listTotal}` : '0 resultados';
    const prev = document.getElementById('dsp-pag-prev');
    const next = document.getElementById('dsp-pag-next');
    if (prev) prev.disabled = _listPage === 0;
    if (next) next.disabled = to >= _listTotal;
  }

  async function loadListData() {
    const today = new Date();
    const toISO = d => d.toISOString().split('T')[0];
    let data_de = null, data_ate = null;
    if (_listFilters.data === 'hoje') { data_de = data_ate = toISO(today); }
    else if (_listFilters.data === '7d') { const d = new Date(today); d.setDate(d.getDate()-6); data_de = toISO(d); data_ate = toISO(today); }
    else if (_listFilters.data === '30d') { const d = new Date(today); d.setDate(d.getDate()-29); data_de = toISO(d); data_ate = toISO(today); }

    const params = new URLSearchParams({
      limit: LIST_PER_PAGE,
      offset: _listPage * LIST_PER_PAGE,
      ...((_listFilters.busca) && { busca: _listFilters.busca }),
      ...((_listFilters.status !== 'todos') && { status: _listFilters.status }),
      ...((_listFilters.origem !== 'todos') && { origem: _listFilters.origem }),
      ...(data_de && { data_de }),
      ...(data_ate && { data_ate }),
    });
    const r = await fetch(api(`/api/pedidos?${params}`)).catch(() => null);
    const d = r?.ok ? await r.json() : { rows: [], total: 0 };
    _listRows  = d.rows || [];
    _listTotal = d.total || 0;
  }

  function bindListEvents() {
    document.getElementById('dsp-back-kanban')?.addEventListener('click', () => { _view = 'kanban'; loadAndRender(); });
    document.getElementById('dsp-btn-estornos')?.addEventListener('click', renderEstornosView);

    // Filters — debounce search, immediate for selects
    let searchTimer = null;
    document.getElementById('dsp-busca')?.addEventListener('input', e => {
      _listFilters.busca = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => { _listPage = 0; await loadListData(); document.getElementById('dsp-tbody').innerHTML = renderTbody(); updatePaginationInfo(); }, 400);
    });
    ['dsp-fil-status','dsp-fil-origem','dsp-fil-data'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', async e => {
        const key = id.replace('dsp-fil-','');
        _listFilters[key] = e.target.value;
        _listPage = 0;
        await loadListData();
        document.getElementById('dsp-tbody').innerHTML = renderTbody();
        updatePaginationInfo();
      });
    });

    // Pagination
    document.getElementById('dsp-pag-prev')?.addEventListener('click', async () => {
      if (_listPage > 0) { _listPage--; await loadListData(); document.getElementById('dsp-tbody').innerHTML = renderTbody(); updatePaginationInfo(); }
    });
    document.getElementById('dsp-pag-next')?.addEventListener('click', async () => {
      if ((_listPage+1)*LIST_PER_PAGE < _listTotal) { _listPage++; await loadListData(); document.getElementById('dsp-tbody').innerHTML = renderTbody(); updatePaginationInfo(); }
    });

    // Row click → details, menu btn → dropdown
    document.getElementById('dsp-tbody')?.addEventListener('click', e => {
      const menuBtn = e.target.closest('[data-menu-pedido]');
      if (menuBtn) { e.stopPropagation(); openRowMenu(menuBtn, +menuBtn.dataset.menuPedido); return; }
      const row = e.target.closest('[data-pedido-id]');
      if (row) openDetalhesPedido(+row.dataset.pedidoId);
    });
  }

  function openRowMenu(btn, pedidoId) {
    document.querySelector('.dsp-dropdown')?.remove();
    const pedido = _listRows.find(p => p.id === pedidoId);
    const podeEstornar = pedido && pedido.asaas_payment_id && !['estornado','cancelado'].includes(pedido.status);
    const dd = document.createElement('div');
    dd.className = 'dsp-dropdown';
    dd.innerHTML = `
      <button class="dsp-dropdown-item" data-dd-detalhe="${pedidoId}">Ver detalhes</button>
      ${podeEstornar ? `<div class="dsp-dropdown-sep"></div><button class="dsp-dropdown-item danger" data-dd-estornar="${pedidoId}">Estornar</button>` : ''}`;
    const rect = btn.getBoundingClientRect();
    dd.style.top  = (rect.bottom + 4) + 'px';
    dd.style.left = Math.max(8, rect.right - 160) + 'px';
    document.body.appendChild(dd);
    dd.querySelector(`[data-dd-detalhe]`)?.addEventListener('click', () => { dd.remove(); openDetalhesPedido(pedidoId); });
    dd.querySelector(`[data-dd-estornar]`)?.addEventListener('click', () => { dd.remove(); openEstornarDialog(pedidoId); });
    const close = e => { if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // ── Estorno dialog ───────────────────────────────────────────────────
  function openEstornarDialog(pedidoId) {
    const pedido = _listRows.find(p => p.id === pedidoId);
    if (!pedido) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'dsp-drawer-backdrop';
    backdrop.style.zIndex = '300';
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#111;border:1px solid var(--border);border-radius:6px;width:440px;z-index:301;box-shadow:0 16px 48px rgba(0,0,0,.5)';
    modal.innerHTML = `
      <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:14px;font-weight:600;color:var(--text)">Estornar pedido #${esc(pedido.codigo)}</span>
        <button class="dsp-icon-btn" id="dsp-est-close">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="12" y2="12"/><line x1="12" y1="1" x2="1" y2="12"/></svg>
        </button>
      </div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
        <div style="padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:3px;font-size:12px;color:var(--text-muted)">
          <strong style="color:var(--text)">${esc(pedido.cliente_nome||'—')}</strong> · Total: <strong style="color:var(--teal)">${fmtPreco(pedido.total)}</strong>
        </div>
        <div class="dsp-form-row">
          <label class="dsp-form-label">Valor a estornar</label>
          <input id="dsp-est-valor" class="dsp-form-input" type="number" min="0.01" step="0.01" value="${(pedido.total||0).toFixed(2)}">
        </div>
        <div class="dsp-form-row">
          <label class="dsp-form-label">Motivo (obrigatório)</label>
          <textarea id="dsp-est-motivo" style="height:70px;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 12px;font-family:'Inter',sans-serif;font-size:13px;outline:none;border-radius:2px;resize:none;width:100%" placeholder="Descreva o motivo do estorno..."></textarea>
        </div>
      </div>
      <div style="padding:14px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
        <button class="dsp-btn-ghost" id="dsp-est-cancel">Cancelar</button>
        <button class="dsp-btn" id="dsp-est-confirm" style="background:#ef4444">Confirmar estorno</button>
      </div>`;

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
    const close = () => { backdrop.remove(); modal.remove(); };
    backdrop.addEventListener('click', close);
    modal.querySelector('#dsp-est-close')?.addEventListener('click', close);
    modal.querySelector('#dsp-est-cancel')?.addEventListener('click', close);
    modal.querySelector('#dsp-est-confirm')?.addEventListener('click', async () => {
      const valor  = +(modal.querySelector('#dsp-est-valor')?.value || 0);
      const motivo = modal.querySelector('#dsp-est-motivo')?.value.trim();
      if (!valor || valor <= 0) return window.Toast?.error('Informe o valor do estorno');
      if (!motivo) return window.Toast?.error('Informe o motivo');
      const btn = modal.querySelector('#dsp-est-confirm');
      btn.disabled = true; btn.textContent = 'Processando...';
      const r = await fetch(api('/api/estornos'), {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ pedido_id: pedidoId, valor, motivo }),
      }).catch(() => null);
      const data = r ? await r.json() : null;
      if (data?.ok) {
        window.Toast?.success('Estorno realizado com sucesso');
        close();
        _listPage = 0; await loadListData();
        document.getElementById('dsp-tbody').innerHTML = renderTbody();
        updatePaginationInfo();
      } else {
        window.Toast?.error('Estorno falhou: ' + (data?.error || 'Erro desconhecido'));
        close();
        _listPage = 0; await loadListData();
        document.getElementById('dsp-tbody').innerHTML = renderTbody();
        updatePaginationInfo();
      }
    });
  }

  // ── Histórico de estornos ────────────────────────────────────────────
  async function renderEstornosView() {
    if (!_container) return;
    const estornos = await fetch(api('/api/estornos')).then(r => r.json()).catch(() => []);
    _container.innerHTML = `
      <div class="dsp-list-root">
        <div class="dsp-list-bar">
          <button class="dsp-btn-ghost" id="dsp-back-lista">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="8 1 2 6.5 8 12"/></svg>
            Voltar à lista
          </button>
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted)">Histórico de Estornos</span>
        </div>
        <div class="dsp-table-wrap">
          <table class="dsp-table">
            <thead><tr>
              <th>Pedido</th><th>Cliente</th><th>Valor estornado</th><th>Motivo</th><th>Status</th><th>Data</th>
            </tr></thead>
            <tbody>
              ${estornos.length ? estornos.map(e => `
                <tr>
                  <td class="td-code">#${esc(e.codigo)}</td>
                  <td class="td-nome">${esc(e.cliente_nome||'—')}</td>
                  <td class="td-total">${fmtPreco(e.valor)}</td>
                  <td style="font-size:12px;color:var(--text-muted);max-width:200px">${esc(e.motivo||'—')}</td>
                  <td><span class="dsp-status-pill ${e.status==='concluido'?'finalizado':e.status==='falhou'?'cancelado':'aguardando_coleta'}">${esc(e.status)}</span></td>
                  <td style="font-size:12px;white-space:nowrap">${fmtData(e.criado_em)}</td>
                </tr>`).join('') :
                '<tr><td colspan="6"><div class="dsp-empty">Nenhum estorno registrado</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    document.getElementById('dsp-back-lista')?.addEventListener('click', renderListView);
  }

  // ── Utilities ────────────────────────────────────────────────────────
  function tryParseItens(raw) {
    if (!raw) return [];
    try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; }
    catch(_) { return []; }
  }

  return { mount, unmount, loadAndRender };
})();
