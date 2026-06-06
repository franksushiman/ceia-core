/**
 * Motoboys — Fase 9 do CEIA OS
 * Frota completa: Fixo | Freelancer | Nuvem
 */
const Motoboys = (() => {
  function api(path) { return ((window.CEIA?.apiBase) || 'http://127.0.0.1:3000') + path; }

  // ── State ────────────────────────────────────────────────────────────────────
  let _frota       = [];
  let _filtro      = 'todos'; // todos | ONLINE | EM_ROTA | OFFLINE
  let _busca       = '';
  let _container   = null;

  // SSE / SOS state
  let _sseES       = null;
  let _sosSessoes  = new Map(); // telegram_id → { nome, lat, lng, msgs: [{from,texto,ts}] }
  let _sosDrawer   = null;     // { telegram_id, drawer, renderMsgs, close }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function esc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtPreco(v) { return 'R$ ' + (+(v||0)).toFixed(2).replace('.',','); }
  function fmtData(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) + ' ' +
           dt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  }

  // Máscara CPF: 000.000.000-00
  function mascararDocumento(v) {
    v = v.replace(/\D/g, '').slice(0,11);
    if (v.length <= 3)  return v;
    if (v.length <= 6)  return v.replace(/(\d{3})(\d+)/, '$1.$2');
    if (v.length <= 9)  return v.replace(/(\d{3})(\d{3})(\d+)/, '$1.$2.$3');
    return v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
  }

  function validarDocumento(cpf) {
    cpf = cpf.replace(/\D/g, '');
    if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
    let s = 0;
    for (let i = 0; i < 9; i++) s += +cpf[i] * (10 - i);
    let r = (s * 10) % 11; if (r === 10 || r === 11) r = 0;
    if (r !== +cpf[9]) return false;
    s = 0;
    for (let i = 0; i < 10; i++) s += +cpf[i] * (11 - i);
    r = (s * 10) % 11; if (r === 10 || r === 11) r = 0;
    return r === +cpf[10];
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  function mount(container) {
    _container = container;
    container.style.display = 'block';
    iniciarSSE();
    loadAndRender();
  }

  function unmount(container) {
    pararSSE();
    _container = null;
    if (container) container.style.display = '';
  }

  // ── Data ─────────────────────────────────────────────────────────────────────
  async function loadAndRender() {
    try {
      _frota = await fetch(api('/api/fleet')).then(r => r.json()).catch(() => []);
      if (!Array.isArray(_frota)) _frota = [];
    } catch (_) { _frota = []; }
    render();
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function render() {
    if (!_container) return;

    const online  = _frota.filter(m => m.operacional_status === 'ONLINE').length;
    const emRota  = _frota.filter(m => ['EM_ROTA','EM_ENTREGA'].includes(m.operacional_status)).length;
    const ativos  = _frota.filter(m => m.status === 'ativo').length;

    let visivel = _frota;
    if (_filtro !== 'todos') {
      visivel = visivel.filter(m =>
        _filtro === 'EM_ROTA'
          ? ['EM_ROTA','EM_ENTREGA'].includes(m.operacional_status)
          : m.operacional_status === _filtro
      );
    }
    if (_busca) {
      const q = _busca.toLowerCase();
      visivel = visivel.filter(m => (m.nome||'').toLowerCase().includes(q) ||
        (m.vinculo||'').toLowerCase().includes(q));
    }

    _container.innerHTML = `
      <div class="mb-root">
        <div class="mb-bar">
          <div class="mb-bar-left">
            <span class="mb-title">Motoboys</span>
            <span class="mb-count">(${ativos} ativo${ativos !== 1 ? 's' : ''}${online ? ` · ${online} online` : ''}${emRota ? ` · ${emRota} em rota` : ''})</span>
          </div>
          <div class="mb-bar-right">
            <input class="mb-search" id="mb-search" type="text" placeholder="Buscar motoboy…" value="${esc(_busca)}" autocomplete="off">
            <button class="dsp-btn" id="mb-btn-convidar">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="1" y="3" width="8" height="7" rx="1"/>
                <path d="M9 5h2l1 1v3h-3"/>
                <circle cx="3.5" cy="10" r="1"/>
                <circle cx="8" cy="10" r="1"/>
              </svg>
              Convidar motoboy
            </button>
          </div>
        </div>

        <div class="mb-filters">
          ${[['todos','Todos'],['ONLINE','Online'],['EM_ROTA','Em rota'],['OFFLINE','Offline']].map(([v,l]) =>
            `<button class="mb-filter-btn${_filtro===v?' active':''}" data-filtro="${v}">${l}</button>`
          ).join('')}
        </div>

        <div class="mb-body">
          <div class="mb-grid" id="mb-grid">
            ${visivel.length ? visivel.map(renderCard).join('') : '<div class="mb-empty">Nenhum motoboy cadastrado</div>'}
          </div>
        </div>
      </div>`;

    // Bind
    document.getElementById('mb-btn-convidar')?.addEventListener('click', openConvite);
    document.getElementById('mb-search')?.addEventListener('input', e => {
      _busca = e.target.value;
      renderGrid();
    });
    _container.querySelectorAll('.mb-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { _filtro = btn.dataset.filtro; render(); });
    });

    // Delegação de ações dos cards
    _container.querySelector('#mb-grid')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id  = +btn.dataset.id;
      const act = btn.dataset.action;
      if (act === 'editar')   openEditar(id);
      if (act === 'acerto')   openAcerto(id);
      if (act === 'historico')openHistorico(id);
      if (act === 'falar')    openFalar(id);
      if (act === 'dados')    openDadosNuvem(id);
      if (act === 'cancelar') cancelarNuvem(id);
      if (act === 'rastrear') openRastrear(id);
      if (act === 'sos') {
        const mb = _frota.find(x => x.id === id);
        if (mb?.telegram_id) abrirDrawerSOS(String(mb.telegram_id));
      }
    });
  }

  function renderGrid() {
    let visivel = _frota;
    if (_filtro !== 'todos') {
      visivel = visivel.filter(m =>
        _filtro === 'EM_ROTA'
          ? ['EM_ROTA','EM_ENTREGA'].includes(m.operacional_status)
          : m.operacional_status === _filtro
      );
    }
    if (_busca) {
      const q = _busca.toLowerCase();
      visivel = visivel.filter(m => (m.nome||'').toLowerCase().includes(q) ||
        (m.vinculo||'').toLowerCase().includes(q));
    }
    const grid = document.getElementById('mb-grid');
    if (grid) grid.innerHTML = visivel.length
      ? visivel.map(renderCard).join('')
      : '<div class="mb-empty">Nenhum motoboy encontrado</div>';
  }

  function renderCard(m) {
    const isNuvem     = m.vinculo === 'Nuvem';
    const opStatus    = m.operacional_status || 'OFFLINE';
    const emRota      = ['EM_ROTA','EM_ENTREGA'].includes(opStatus);
    const pendente    = m.pagamento_pendente;
    const sosAtivo    = m.telegram_id && _sosSessoes.has(String(m.telegram_id));
    const temPosicao  = (m.lat != null || m.latitude != null) && (m.lng != null || m.longitude != null);
    const statusLabel = opStatus === 'EM_ROTA' ? 'EM ROTA' : opStatus === 'EM_ENTREGA' ? 'EM ENTREGA' : opStatus;
    const cardClass   = ['fleet-card', emRota ? 'em-rota' : '', pendente ? 'pendente' : '', sosAtivo ? 'sos-active' : ''].filter(Boolean).join(' ');

    const acoes = isNuvem
      ? `<button class="btn-fleet" data-action="dados" data-id="${m.id}" title="Dados do parceiro">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6" cy="6" r="5"/><path d="M6 5v4M6 3.5v.5"/></svg>
           Dados
         </button>
         <button class="btn-fleet success" data-action="acerto" data-id="${m.id}" title="Acerto financeiro">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 6h10M6 1v10"/><rect x="2" y="2" width="8" height="8" rx="1"/></svg>
           Acerto
         </button>
         ${!emRota && !pendente ? `<button class="btn-fleet danger" data-action="cancelar" data-id="${m.id}" title="Cancelar parceria">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>
           Cancelar
         </button>` : ''}`
      : `<button class="btn-fleet" data-action="editar" data-id="${m.id}" title="Editar motoboy">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.5l2 2L3.5 11H1.5V9z"/><path d="M7.5 2.5l2 2"/></svg>
           Editar
         </button>
         <button class="btn-fleet success" data-action="acerto" data-id="${m.id}" title="Acerto financeiro">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="2" width="10" height="8" rx="1"/><path d="M1 5h10M4 8h1M7 8h1"/></svg>
           Acerto
         </button>
         <button class="btn-fleet" data-action="historico" data-id="${m.id}" title="Histórico de entregas">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6" cy="6" r="5"/><path d="M6 3.5V6l2 1.5"/></svg>
           Histórico
         </button>
         <button class="btn-fleet" data-action="falar" data-id="${m.id}" title="Enviar mensagem">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10.5 1.5h-9a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2l2 2 2-2h3a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1z"/></svg>
           Falar
         </button>
         ${temPosicao ? `<button class="btn-fleet" data-action="rastrear" data-id="${m.id}" title="Rastrear no mapa">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><path d="M6 1a4 4 0 0 1 4 4c0 3-4 7-4 7S2 8 2 5a4 4 0 0 1 4-4z"/></svg>
           Rastrear
         </button>` : ''}
         ${sosAtivo ? `<button class="btn-fleet danger sos-pulse" data-action="sos" data-id="${m.id}" title="Atender emergência SOS">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6" cy="6" r="5"/><path d="M6 3.5V6M6 8v.5"/></svg>
           SOS
         </button>` : ''}`;

    return `
      <div class="${cardClass}" data-id="${m.id}">
        <div class="fleet-card-head">
          <span class="fleet-nome">${esc(m.nome||'Sem nome')}</span>
          <span class="fleet-status ${opStatus}">${statusLabel}</span>
        </div>
        <div class="fleet-meta">
          ${isNuvem
            ? `<span class="fleet-nuvem-badge">🌐 PARCEIRO NUVEM</span>`
            : `<span class="fleet-vinculo">${esc(m.vinculo||'Fixo')}</span>`
          }
          ${m.veiculo ? `<span style="font-size:11px;color:var(--text-dim)">· ${esc(m.veiculo)}</span>` : ''}
          ${pendente ? `<span class="fleet-pendente-badge">$ Pendente</span>` : ''}
        </div>
        ${isNuvem && m.no_nome ? `<div class="fleet-origem">📍 Origem: ${esc(m.no_nome)}</div>` : ''}
        ${m.ultima_atualizacao ? `<div class="fleet-ts">Atualizado: ${fmtData(m.ultima_atualizacao)}</div>` : ''}
        <div class="fleet-actions">${acoes}</div>
      </div>`;
  }

  // ── Convite QR ───────────────────────────────────────────────────────────────
  async function openConvite() {
    try {
      const r = await fetch(api('/api/gerar-token-bot'), { method: 'POST' }).catch(() => null);
      const data = r?.ok ? await r.json() : null;

      if (!data?.ok) {
        const msg = data?.error || 'Erro ao gerar convite';
        window.Dialog?.alert({
          message: msg.includes('Token') || msg.includes('Telegram')
            ? msg + '\n\nConfigure o token em Configurações → Chaves de API.'
            : msg,
        });
        return;
      }

      const { link, bot_username } = data;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(link)}`;

      // Cria modal próprio (Dialog não suporta HTML complexo)
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:2000;display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:32px;max-width:360px;width:90vw;display:flex;flex-direction:column;align-items:center;gap:16px">
          <div style="font-size:14px;font-weight:600;color:var(--text);letter-spacing:-0.02em">Convite de cadastro</div>
          <div style="font-size:12px;color:var(--text-muted);text-align:center">Mostre para o motoboy escanear com o Telegram</div>
          <img src="${qrUrl}" width="220" height="220" style="border-radius:4px;background:#fff;padding:6px" alt="QR Code">
          <div style="display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:3px;padding:8px 10px;width:100%">
            <span id="mb-invite-link" style="flex:1;font-size:11px;color:var(--text-muted);word-break:break-all;letter-spacing:-.01em">${esc(link)}</span>
            <button id="mb-copy-link" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:11px;white-space:nowrap;transition:color .15s">Copiar</button>
          </div>
          <div style="font-size:11px;color:var(--text-dim)">Bot: @${esc(bot_username)}</div>
          <button id="mb-invite-close" style="height:34px;padding:0 20px;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);border-radius:3px;cursor:pointer;font-size:12px;font-weight:500">Fechar</button>
        </div>`;

      document.body.appendChild(overlay);
      overlay.querySelector('#mb-invite-close')?.addEventListener('click', () => overlay.remove());
      overlay.querySelector('#mb-copy-link')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(link).catch(() => {});
        const btn = overlay.querySelector('#mb-copy-link');
        btn.textContent = 'Copiado!'; btn.style.color = 'var(--status-ok)';
        setTimeout(() => { btn.textContent = 'Copiar'; btn.style.color = ''; }, 2000);
      });
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    } catch (e) {
      window.Dialog?.alert({ message: 'Erro inesperado ao gerar convite.' });
    }
  }

  // ── Editar motoboy ───────────────────────────────────────────────────────────
  async function openEditar(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;

    const { backdrop, drawer, close } = criarDrawer(`Editar: ${m.nome}`);
    drawer.querySelector('.mb-drawer-body').innerHTML = `
      <div>
        <label class="mb-form-label">Nome</label>
        <input id="mb-ed-nome" class="mb-form-input" type="text" value="${esc(m.nome||'')}">
      </div>
      <div>
        <label class="mb-form-label">WhatsApp</label>
        <input id="mb-ed-wa" class="mb-form-input" type="text" placeholder="(XX) XXXXX-XXXX" value="${esc(m.whatsapp||m.telefone||'')}">
      </div>
      <div>
        <label class="mb-form-label">Vínculo</label>
        <select id="mb-ed-vinculo" class="mb-form-select">
          ${['Fixo','Freelancer'].map(v => `<option${m.vinculo===v?' selected':''}>${v}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="mb-form-label">Veículo</label>
        <select id="mb-ed-veiculo" class="mb-form-select">
          ${['Moto','Carro','Bike'].map(v => `<option${m.veiculo===v?' selected':''}>${v}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="mb-form-label">Chave PIX</label>
        <input id="mb-ed-pix" class="mb-form-input" type="text" placeholder="CPF, e-mail, telefone ou chave aleatória" value="${esc(m.pix||'')}">
      </div>
      <div>
        <label class="mb-form-label">CPF</label>
        <input id="mb-ed-cpf" class="mb-form-input" type="text" placeholder="000.000.000-00" maxlength="14" value="${esc(m.cpf||'')}">
      </div>`;

    // Máscara CPF
    drawer.querySelector('#mb-ed-cpf')?.addEventListener('input', function() {
      this.value = mascararDocumento(this.value);
    });

    drawer.querySelector('.mb-drawer-footer').innerHTML = `
      <button class="dsp-btn-ghost danger" id="mb-ed-excluir" style="margin-right:auto">Excluir</button>
      <button class="dsp-btn-ghost" id="mb-ed-cancel">Cancelar</button>
      <button class="dsp-btn" id="mb-ed-salvar">Salvar</button>`;

    drawer.querySelector('#mb-ed-cancel')?.addEventListener('click', close);
    drawer.querySelector('#mb-ed-excluir')?.addEventListener('click', async () => {
      const ok = await window.Dialog?.confirm({
        title: 'Excluir motoboy',
        message: `Excluir ${m.nome} definitivamente? Esta ação não pode ser desfeita.`,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      const dr = await fetch(api(`/api/fleet/${id}`), { method: 'DELETE' }).catch(() => null);
      if (!dr?.ok) {
        const body = await dr?.json().catch(() => null);
        window.Toast?.error(body?.error || 'Erro ao excluir motoboy');
        return;
      }
      close(); loadAndRender();
    });

    drawer.querySelector('#mb-ed-salvar')?.addEventListener('click', async () => {
      const cpfVal = drawer.querySelector('#mb-ed-cpf')?.value || '';
      if (cpfVal && !validarDocumento(cpfVal)) {
        return window.Toast?.error('CPF inválido');
      }
      const body = {
        nome:    drawer.querySelector('#mb-ed-nome')?.value.trim(),
        whatsapp:drawer.querySelector('#mb-ed-wa')?.value.trim() || null,
        telefone:drawer.querySelector('#mb-ed-wa')?.value.trim() || null,
        vinculo: drawer.querySelector('#mb-ed-vinculo')?.value,
        veiculo: drawer.querySelector('#mb-ed-veiculo')?.value,
        pix:     drawer.querySelector('#mb-ed-pix')?.value.trim() || null,
        cpf:     cpfVal || null,
      };
      if (!body.nome) return window.Toast?.error('Informe o nome');
      const r = await fetch(api(`/api/fleet/${id}`), {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      }).catch(() => null);
      if (r?.ok) { window.Toast?.success('Motoboy atualizado!'); close(); loadAndRender(); }
      else window.Toast?.error('Erro ao salvar');
    });
  }

  // ── Acerto financeiro ────────────────────────────────────────────────────────
  async function openAcerto(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;
    const { backdrop, drawer, close } = criarDrawer(`Acerto: ${m.nome}`);

    const body = drawer.querySelector('.mb-drawer-body');
    body.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">Carregando extrato…</div>';

    const extrato = await fetch(api(`/api/fleet/${id}/extrato`)).then(r => r.json()).catch(() => []);
    // Suporta tanto tabela entregas (valor_entrega) quanto fallback legado (taxa_entrega)
    const total   = extrato.reduce((s, r) => s + (r.valor_entrega ?? r.taxa_entrega ?? 0), 0);

    body.innerHTML = `
      <div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:8px">Entregas pendentes de acerto</div>
        ${extrato.length
          ? extrato.map(row => `
              <div class="mb-extrato-row">
                <div>
                  <div style="font-size:12px;color:var(--text)">${esc(row.cliente_nome||'Pedido')} ${row.bairro ? `· ${esc(row.bairro)}` : ''}</div>
                  <div style="font-size:10px;color:var(--text-dim)">${fmtData(row.data || row.finalizado_em)}</div>
                </div>
                <span class="val">${fmtPreco(row.valor_entrega ?? row.taxa_entrega ?? 0)}</span>
              </div>`).join('')
          : '<div style="font-size:12px;color:var(--text-dim)">Nenhuma entrega pendente</div>'
        }
        <div class="mb-extrato-total">
          <span>Total a pagar</span>
          <span class="val">${fmtPreco(total)}</span>
        </div>
      </div>
      ${m.pix ? `
        <div>
          <label class="mb-form-label">Chave PIX</label>
          <div class="mb-pix-row">
            <span class="mb-pix-val">${esc(m.pix)}</span>
            <button class="mb-pix-copy" id="mb-ac-pix-copy">Copiar</button>
          </div>
        </div>` : '<div style="font-size:12px;color:var(--text-dim)">Chave PIX não cadastrada</div>'
      }`;

    drawer.querySelector('#mb-ac-pix-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(m.pix).catch(() => {});
      window.Toast?.success('PIX copiado!');
    });

    drawer.querySelector('.mb-drawer-footer').innerHTML = `
      <button class="dsp-btn-ghost" id="mb-ac-cancel">Fechar</button>
      <button class="dsp-btn" id="mb-ac-zerar" ${!extrato.length ? 'disabled' : ''}>Confirmar pagamento</button>`;

    drawer.querySelector('#mb-ac-cancel')?.addEventListener('click', close);
    drawer.querySelector('#mb-ac-zerar')?.addEventListener('click', async () => {
      const ok = await window.Dialog?.confirm({
        title: 'Confirmar pagamento',
        message: `Confirmar pagamento de ${fmtPreco(total)} para ${m.nome}?\n\nIsso zerará o extrato pendente.`,
        confirmText: 'Confirmar',
      });
      if (!ok) return;
      const r = await fetch(api(`/api/fleet/${id}/zerar-acerto`), { method: 'POST' }).catch(() => null);
      if (r?.ok) { window.Toast?.success('Acerto realizado!'); close(); loadAndRender(); }
      else window.Toast?.error('Erro ao zerar acerto');
    });
  }

  // ── Histórico ────────────────────────────────────────────────────────────────
  async function openHistorico(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;
    const { drawer, close } = criarDrawer(`Histórico: ${m.nome}`);

    const body = drawer.querySelector('.mb-drawer-body');
    body.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">Carregando…</div>';

    const hist = await fetch(api(`/api/fleet/${id}/historico`)).then(r => r.json()).catch(() => []);

    body.innerHTML = hist.length
      ? hist.map(row => `
          <div class="mb-extrato-row">
            <div>
              <div style="font-size:12px;color:var(--text)">${esc(row.codigo||'#')} · ${esc(row.cliente_nome||'Cliente')}</div>
              <div style="font-size:10px;color:var(--text-dim)">${esc(row.bairro||'')} · ${fmtData(row.finalizado_em)}</div>
            </div>
            <span class="val">${fmtPreco(row.total)}</span>
          </div>`).join('')
      : '<div style="font-size:12px;color:var(--text-dim)">Nenhuma entrega registrada</div>';

    drawer.querySelector('.mb-drawer-footer').innerHTML =
      `<button class="dsp-btn-ghost" id="mb-hist-close">Fechar</button>`;
    drawer.querySelector('#mb-hist-close')?.addEventListener('click', close);
  }

  // ── Falar (Telegram) ─────────────────────────────────────────────────────────
  function openFalar(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;
    if (!m.telegram_id) {
      window.Dialog?.alert({ message: `${m.nome} ainda não vinculou o Telegram.\n\nUse "Convidar motoboy" para enviar o link de cadastro.` });
      return;
    }

    const { drawer, close } = criarDrawer(`Falar com ${m.nome}`);
    drawer.querySelector('.mb-drawer-body').innerHTML = `
      <div>
        <label class="mb-form-label">Mensagem</label>
        <textarea id="mb-chat-msg" style="width:100%;height:100px;padding:8px 10px;font-size:13px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:3px;resize:vertical;outline:none;font-family:inherit" placeholder="Digite sua mensagem…"></textarea>
      </div>`;

    drawer.querySelector('.mb-drawer-footer').innerHTML = `
      <button class="dsp-btn-ghost" id="mb-chat-cancel">Cancelar</button>
      <button class="dsp-btn" id="mb-chat-enviar">Enviar</button>`;

    drawer.querySelector('#mb-chat-cancel')?.addEventListener('click', close);
    drawer.querySelector('#mb-chat-enviar')?.addEventListener('click', async () => {
      const msg = drawer.querySelector('#mb-chat-msg')?.value.trim();
      if (!msg) return window.Toast?.error('Escreva uma mensagem');
      const r = await fetch(api('/api/chat/motoboy'), {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ telegram_id: m.telegram_id, mensagem: msg }),
      }).catch(() => null);
      if (r?.ok) { window.Toast?.success('Mensagem enviada!'); close(); }
      else window.Toast?.error('Erro ao enviar mensagem via Telegram');
    });
  }

  // ── Nuvem ────────────────────────────────────────────────────────────────────
  function openDadosNuvem(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;
    const { drawer, close } = criarDrawer('Dados do Parceiro Nuvem');
    drawer.querySelector('.mb-drawer-body').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        ${[['Nome', m.nome], ['Vínculo', m.vinculo], ['Veículo', m.veiculo],
           ['Origem', m.no_nome], ['Chave PIX', m.pix], ['WhatsApp', m.whatsapp||m.telefone]
          ].map(([k,v]) => v ? `
            <div>
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:3px">${k}</div>
              <div style="font-size:13px;color:var(--text)">${esc(v)}</div>
            </div>` : '').join('')}
      </div>`;
    drawer.querySelector('.mb-drawer-footer').innerHTML =
      `<button class="dsp-btn-ghost" id="mb-nv-close">Fechar</button>`;
    drawer.querySelector('#mb-nv-close')?.addEventListener('click', close);
  }

  async function cancelarNuvem(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;
    const ok = await window.Dialog?.confirm({
      title: 'Cancelar parceria',
      message: `Cancelar parceria com ${m.nome} (${m.no_nome||'Nuvem'})?\n\nEle será removido da sua frota.`,
      confirmText: 'Cancelar parceria',
      danger: true,
    });
    if (!ok) return;
    await fetch(api(`/api/fleet/${id}`), {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: 'inativo' }),
    }).catch(() => {});
    window.Toast?.success('Parceria cancelada');
    loadAndRender();
  }

  // ── SSE ──────────────────────────────────────────────────────────────────────
  function iniciarSSE() {
    if (_sseES && _sseES.readyState !== EventSource.CLOSED) return;
    _sseES = new EventSource(api('/api/eventos')); // era /api/sse (endpoint inexistente)
    _sseES.onmessage = e => {
      try {
        const { tipo, data } = JSON.parse(e.data);
        handleSSEMotoboys(tipo, data);
      } catch (_) {}
    };
    _sseES.onerror = () => {
      if (_sseES && _sseES.readyState === EventSource.CLOSED) {
        pararSSE();
        setTimeout(iniciarSSE, 3000);
      }
    };
  }

  function pararSSE() {
    if (_sseES) { try { _sseES.close(); } catch (_) {} _sseES = null; }
  }

  function handleSSEMotoboys(tipo, data) {
    if (tipo === 'SOS') {
      const { telegram_id, motoboy_nome, lat, lng } = data;
      const tid = String(telegram_id);
      _sosSessoes.set(tid, { nome: motoboy_nome || 'Motoboy', lat, lng, msgs: [] });
      renderGrid();
      window.Toast?.error(`🆘 ${motoboy_nome || 'Motoboy'} acionou emergência!`);
      tocarAlertaSOS();

    } else if (tipo === 'SOS_MSG' || tipo === 'SOS_OP_MSG') {
      const { telegram_id, texto, from } = data;
      const tid = String(telegram_id);
      const s = _sosSessoes.get(tid);
      if (s) s.msgs.push({ from: from || (tipo === 'SOS_OP_MSG' ? 'operador' : 'motoboy'), texto, ts: Date.now() });
      if (_sosDrawer?.telegram_id === tid) _sosDrawer.renderMsgs();

    } else if (tipo === 'SOS_ENCERRADO') {
      const tid = String(data?.telegram_id);
      _sosSessoes.delete(tid);
      if (_sosDrawer?.telegram_id === tid) { _sosDrawer.close(); _sosDrawer = null; }
      renderGrid();
    }
  }

  function tocarAlertaSOS() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 660, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.12);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime + i * 0.15 + 0.12);
      });
    } catch (_) {}
  }

  // ── SOS Drawer ───────────────────────────────────────────────────────────────
  function abrirDrawerSOS(telegram_id) {
    const sessao = _sosSessoes.get(telegram_id);
    if (!sessao) return;

    // Fecha drawer SOS anterior se existir
    if (_sosDrawer) { _sosDrawer.close(); _sosDrawer = null; }

    const { backdrop, drawer, close: rawClose } = criarDrawer(`🆘 SOS — ${sessao.nome}`);

    const close = () => {
      if (_sosDrawer?.telegram_id === telegram_id) _sosDrawer = null;
      rawClose();
    };

    // Re-bind backdrop e X para usar close com limpeza de estado
    backdrop.onclick = close;
    const xBtn = drawer.querySelector('#mb-drawer-close-x');
    if (xBtn) xBtn.onclick = close;

    function renderMsgs() {
      const s = _sosSessoes.get(telegram_id);
      const chatDiv = drawer.querySelector('#mb-sos-chat');
      if (!chatDiv || !s) return;
      chatDiv.innerHTML = s.msgs.length
        ? s.msgs.map(msg => `
            <div style="margin-bottom:8px;text-align:${msg.from==='operador'?'right':'left'}">
              <span style="display:inline-block;max-width:80%;padding:5px 9px;border-radius:6px;font-size:12px;word-break:break-word;
                           background:${msg.from==='operador'?'var(--accent, #3b7ff5)':'var(--surface)'};
                           color:${msg.from==='operador'?'#fff':'var(--text)'}">
                ${esc(msg.texto)}
              </span>
              <div style="font-size:10px;color:var(--text-dim);margin-top:2px">
                ${msg.from === 'operador' ? 'Você' : esc(sessao.nome)}
              </div>
            </div>`).join('')
        : '<div style="font-size:12px;color:var(--text-dim)">Aguardando mensagem…</div>';
      chatDiv.scrollTop = chatDiv.scrollHeight;
    }

    drawer.querySelector('.mb-drawer-body').innerHTML = `
      <div id="mb-sos-chat" style="height:260px;overflow-y:auto;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg-alt,var(--bg));margin-bottom:10px"></div>
      <div>
        <label class="mb-form-label">Resposta</label>
        <textarea id="mb-sos-reply" style="width:100%;height:68px;padding:8px;font-size:12px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:3px;resize:none;outline:none;font-family:inherit" placeholder="Digite sua resposta…"></textarea>
      </div>`;

    renderMsgs();

    drawer.querySelector('.mb-drawer-footer').innerHTML = `
      <button class="dsp-btn-ghost danger" id="mb-sos-encerrar" style="margin-right:auto">Encerrar SOS</button>
      <button class="dsp-btn-ghost" id="mb-sos-cancel">Fechar</button>
      <button class="dsp-btn" id="mb-sos-send">Enviar</button>`;

    _sosDrawer = { telegram_id, drawer, renderMsgs, close };

    drawer.querySelector('#mb-sos-cancel')?.addEventListener('click', close);

    drawer.querySelector('#mb-sos-send')?.addEventListener('click', async () => {
      const txt = drawer.querySelector('#mb-sos-reply')?.value.trim();
      if (!txt) return;
      const r = await fetch(api('/api/operacao/sos/reply'), {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ telegram_id, mensagem: txt }),
      }).catch(() => null);
      if (r?.ok) {
        drawer.querySelector('#mb-sos-reply').value = '';
      } else {
        window.Toast?.error('Erro ao enviar resposta');
      }
    });

    drawer.querySelector('#mb-sos-reply')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        drawer.querySelector('#mb-sos-send')?.click();
      }
    });

    drawer.querySelector('#mb-sos-encerrar')?.addEventListener('click', async () => {
      const ok = await window.Dialog?.confirm({
        title: 'Encerrar SOS',
        message: `Encerrar emergência de ${sessao.nome}?`,
        confirmText: 'Encerrar',
        danger: true,
      });
      if (!ok) return;
      const r = await fetch(api('/api/operacao/sos/encerrar'), {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ telegram_id }),
      }).catch(() => null);
      if (!r?.ok) window.Toast?.error('Erro ao encerrar SOS');
      // SSE SOS_ENCERRADO fechará o drawer automaticamente
    });
  }

  // ── Rastreamento ao vivo ─────────────────────────────────────────────────────
  async function openRastrear(id) {
    const m = _frota.find(x => x.id === id);
    if (!m) return;

    const lat0 = m.lat ?? m.latitude;
    const lng0 = m.lng ?? m.longitude;
    if (lat0 == null || lng0 == null) {
      window.Toast?.warn('Localização não disponível para este motoboy');
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;width:min(92vw,620px);height:520px;display:flex;flex-direction:column;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
          <span style="font-size:13px;font-weight:600;color:var(--text)">📍 Rastreamento — ${esc(m.nome)}</span>
          <button id="mb-rast-close" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:20px;line-height:1;padding:0 4px">×</button>
        </div>
        <div id="mb-rast-map" style="flex:1;min-height:0"></div>
        <div id="mb-rast-ts" style="padding:6px 16px;font-size:10px;color:var(--text-dim);border-top:1px solid var(--border);flex-shrink:0">Aguardando posição…</div>
      </div>`;
    document.body.appendChild(overlay);

    let interval = null;
    let mapInstance = null;
    let marker = null;

    const closeModal = () => {
      clearInterval(interval);
      overlay.remove();
    };
    overlay.querySelector('#mb-rast-close')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    // Carrega Google Maps
    try {
      await window.CeiaGMaps?.load();
      const pos = { lat: +lat0, lng: +lng0 };
      mapInstance = new google.maps.Map(document.getElementById('mb-rast-map'), {
        center: pos, zoom: 15,
        disableDefaultUI: false,
        mapTypeId: 'roadmap',
      });
      marker = new google.maps.Marker({ position: pos, map: mapInstance, title: m.nome });
      document.getElementById('mb-rast-ts').textContent = `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}`;
    } catch (e) {
      const mapEl = document.getElementById('mb-rast-map');
      if (mapEl) {
        mapEl.style.cssText += ';display:flex;align-items:center;justify-content:center';
        mapEl.textContent = 'Mapa indisponível — configure a chave Google Maps em Configurações.';
        mapEl.style.fontSize = '12px';
        mapEl.style.color = 'var(--text-dim)';
        mapEl.style.padding = '20px';
        mapEl.style.textAlign = 'center';
      }
      return;
    }

    // Polling a cada 10 s
    async function refreshPos() {
      try {
        const frota = await fetch(api('/api/fleet')).then(r => r.json());
        const updated = Array.isArray(frota) ? frota.find(x => x.id === id) : null;
        if (!updated) return;
        const lat = updated.lat ?? updated.latitude;
        const lng = updated.lng ?? updated.longitude;
        if (lat != null && lng != null && marker) {
          const pos = { lat: +lat, lng: +lng };
          marker.setPosition(pos);
          mapInstance?.panTo(pos);
        }
        const ts = document.getElementById('mb-rast-ts');
        if (ts) ts.textContent = `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}`;
      } catch (_) {}
    }

    interval = setInterval(refreshPos, 10000);
  }

  // ── Utilitário: cria drawer padrão ───────────────────────────────────────────
  function criarDrawer(titulo) {
    const backdrop = document.createElement('div');
    backdrop.className = 'mb-drawer-backdrop';
    const drawer = document.createElement('div');
    drawer.className = 'mb-drawer';
    drawer.innerHTML = `
      <div class="mb-drawer-header">
        <span class="mb-drawer-title">${esc(titulo)}</span>
        <button class="dsp-icon-btn" id="mb-drawer-close-x">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="12" y2="12"/><line x1="12" y1="1" x2="1" y2="12"/></svg>
        </button>
      </div>
      <div class="mb-drawer-body"></div>
      <div class="mb-drawer-footer"></div>`;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    const close = () => { backdrop.remove(); drawer.remove(); };
    backdrop.addEventListener('click', close);
    drawer.querySelector('#mb-drawer-close-x')?.addEventListener('click', close);

    return { backdrop, drawer, close };
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  return { mount, unmount };
})();
