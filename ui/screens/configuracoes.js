/**
 * Configurações — abas: Restaurante, Horários, Chaves de API, Comportamento IA, Pagamentos, WhatsApp, Marketing
 */
const Configuracoes = (() => {
  function apiBase() { return (window.CEIA?.apiBase) || 'http://127.0.0.1:3000'; }

  // ── State ──────────────────────────────────────────────────────────────
  let _settings     = {};
  let _activeTab    = 'restaurante';
  let _saveTimer    = null;
  let _pending      = {};
  const TABS = [
    { id: 'restaurante', label: 'Restaurante' },
    { id: 'horarios',    label: 'Horários' },
    { id: 'chaves',      label: 'Chaves de API' },
    { id: 'ia',          label: 'Comportamento IA' },
    { id: 'pagamentos',  label: 'Pagamentos' },
    { id: 'whatsapp',    label: 'WhatsApp' },
    { id: 'marketing',   label: 'Marketing' },
  ];

  const DIAS = [
    { key: 'seg', label: 'Segunda-feira' },
    { key: 'ter', label: 'Terça-feira' },
    { key: 'qua', label: 'Quarta-feira' },
    { key: 'qui', label: 'Quinta-feira' },
    { key: 'sex', label: 'Sexta-feira' },
    { key: 'sab', label: 'Sábado' },
    { key: 'dom', label: 'Domingo' },
  ];

  // Keys that must NOT be saved via autosave (have dedicated save buttons)
  const MANUAL_KEYS = ['google_maps_key', 'openai_key', 'asaas_key', 'telegram_token', 'CEIA_NODE_TOKEN'];

  function s(key, fallback = '') { return _settings[key] ?? fallback; }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function mount(container) {
    container.style.display = 'block';
    container.innerHTML = renderShell();
    loadSettings();
  }

  function unmount() {}

  // ── Shell ──────────────────────────────────────────────────────────────
  function renderShell() {
    const tabsHtml = TABS.map(t =>
      `<button class="cfg2-tab${t.id === _activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
    ).join('');
    return `
      <div class="cfg2-tabs" id="cfg2-tabs">${tabsHtml}</div>
      <div class="cfg2-wrap">
        <div id="cfg2-content"></div>
      </div>
      <div class="cfg2-save-status" id="cfg2-save-status">
        <span class="cfg2-save-dot"></span>
        <span id="cfg2-save-text">Salvando...</span>
      </div>`;
  }

  async function loadSettings() {
    try {
      const r = await fetch(apiBase() + '/api/settings');
      if (r.ok) _settings = await r.json();
    } catch (_) {}
    renderTab(_activeTab);
    bindTabNav();
  }

  function bindTabNav() {
    document.getElementById('cfg2-tabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.cfg2-tab');
      if (!btn) return;
      const id = btn.dataset.tab;
      if (id === _activeTab) return;
      document.querySelectorAll('.cfg2-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeTab = id;
      renderTab(id);
    });
  }

  function renderTab(id) {
    const content = document.getElementById('cfg2-content');
    if (!content) return;
    const map = { restaurante: tabRestaurante, horarios: tabHorarios, chaves: tabChaves, ia: tabIA, pagamentos: tabPagamentos, whatsapp: tabWhatsApp, marketing: tabMarketing };
    content.innerHTML = (map[id] || (() => ''))();
    bindTabEvents(id);
    bindAutosave();
  }

  // ── Autosave ──────────────────────────────────────────────────────────
  function bindAutosave() {
    document.getElementById('cfg2-content')?.querySelectorAll('[data-key]').forEach(el => {
      if (MANUAL_KEYS.includes(el.dataset.key)) return;
      if (el.type === 'checkbox') {
        el.addEventListener('change', () => autosave(el.dataset.key, el.checked ? '1' : '0'));
      } else if (el.tagName === 'SELECT') {
        el.addEventListener('change', () => autosave(el.dataset.key, el.value));
      } else {
        el.addEventListener('input', () => autosave(el.dataset.key, el.value));
      }
    });
  }

  function autosave(key, value) {
    _pending[key] = value;
    _settings[key] = value;
    showSaveStatus('saving');
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(flushSave, 800);
  }

  async function flushSave() {
    const fields = { ..._pending };
    if (!Object.keys(fields).length) return;
    _pending = {};
    try {
      const r = await fetch(apiBase() + '/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const data = await r.json();
      showSaveStatus(data.ok ? 'saved' : 'error');
      if (data.ok) setTimeout(() => showSaveStatus('idle'), 2500);
    } catch (_) { showSaveStatus('error'); }
  }

  function showSaveStatus(state) {
    const el  = document.getElementById('cfg2-save-status');
    const txt = document.getElementById('cfg2-save-text');
    if (!el) return;
    el.className = 'cfg2-save-status';
    if (state === 'saving') { el.classList.add('saving'); if (txt) txt.textContent = 'Salvando...'; }
    else if (state === 'saved') { el.classList.add('saved'); if (txt) txt.textContent = 'Salvo'; }
    else if (state === 'error') { el.classList.add('error'); if (txt) txt.textContent = 'Erro ao salvar'; }
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function esc(v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function maskCNPJ(v) {
    v = v.replace(/\D/g, '').slice(0, 14);
    if (v.length > 12) return v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2}).*/, '$1.$2.$3/$4-$5');
    if (v.length > 8)  return v.replace(/^(\d{2})(\d{3})(\d{3})(\d{0,4}).*/, '$1.$2.$3/$4');
    if (v.length > 5)  return v.replace(/^(\d{2})(\d{3})(\d{0,3}).*/, '$1.$2.$3');
    if (v.length > 2)  return v.replace(/^(\d{2})(\d{0,3}).*/, '$1.$2');
    return v;
  }

  function maskPhone(v) {
    v = v.replace(/\D/g, '').slice(0, 11);
    if (v.length > 10) return v.replace(/^(\d{2})(\d{5})(\d{0,4}).*/, '($1) $2-$3');
    if (v.length > 6)  return v.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, '($1) $2-$3');
    if (v.length > 2)  return v.replace(/^(\d{2})(\d{0,5}).*/, '($1) $2');
    if (v.length > 0)  return v.replace(/^(\d{0,2}).*/, '($1');
    return v;
  }

  // ── Tab: Restaurante ───────────────────────────────────────────────────
  function tabRestaurante() {
    const logoUrl = s('loja_logo_url');
    const cor     = s('loja_cor_primaria') || '#00d0b7';
    return `
      <div class="cfg2-section">
        <div class="cfg2-section-title">Identidade</div>

        <div class="cfg2-row">
          <span class="cfg2-label">Logo</span>
          <div class="cfg2-logo-zone" id="cfg2-logo-zone">
            ${logoUrl
              ? `<img src="${esc(logoUrl)}" alt="Logo">`
              : `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="18" height="18"/><circle cx="7.5" cy="7.5" r="1.5"/><polyline points="20 14 15 9 4 20"/></svg>
                 <span>Clique para enviar ou arraste</span>
                 <span style="font-size:10px;color:var(--text-dim)">PNG ou JPG · máx. 2 MB</span>`
            }
            <input type="file" id="cfg2-logo-file" accept="image/png,image/jpeg" style="position:absolute;inset:0;opacity:0;cursor:pointer">
          </div>
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-nome">Nome</label>
          <input id="cfg2-nome" class="cfg2-input" type="text"
                 value="${esc(s('loja_nome'))}" placeholder="Ex: Pizzaria do João" data-key="loja_nome">
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-cnpj">CNPJ</label>
          <input id="cfg2-cnpj" class="cfg2-input" type="text"
                 value="${esc(s('loja_cnpj'))}" placeholder="XX.XXX.XXX/XXXX-XX" data-key="loja_cnpj" maxlength="18">
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-telefone">Telefone</label>
          <input id="cfg2-telefone" class="cfg2-input" type="text"
                 value="${esc(s('loja_telefone'))}" placeholder="(XX) XXXXX-XXXX" data-key="loja_telefone" maxlength="15">
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label">Endereço</label>
          <div style="flex:1;display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;gap:8px">
              <input id="cfg2-endereco" class="cfg2-input" style="flex:1"
                     value="${esc(s('loja_endereco'))}" placeholder="Rua, número, bairro, cidade" data-key="loja_endereco">
              <button id="cfg2-geocode-btn" class="cfg2-btn-ghost">Geocodificar</button>
            </div>
            <div id="cfg2-coords-info" class="cfg2-hint">
              ${s('loja_lat') ? `Coordenadas: ${s('loja_lat')}, ${s('loja_lng')}` : ''}
            </div>
          </div>
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-descricao">Descrição</label>
          <textarea id="cfg2-descricao" class="cfg2-textarea" rows="3"
                    placeholder="Breve descrição exibida na vitrine online"
                    data-key="loja_descricao">${esc(s('loja_descricao'))}</textarea>
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-slogan">Slogan</label>
          <input id="cfg2-slogan" class="cfg2-input" type="text"
                 value="${esc(s('loja_slogan'))}" placeholder="Ex: Sabor de verdade desde 2010"
                 data-key="loja_slogan">
        </div>

        <div class="cfg2-row">
          <label class="cfg2-label">Cor primária</label>
          <div class="cfg2-color-row">
            <input type="color" id="cfg2-color-native" value="${esc(cor)}"
                   style="width:0;height:0;opacity:0;position:absolute;pointer-events:none">
            <button class="cfg2-color-swatch" id="cfg2-color-swatch"
                    style="background:${esc(cor)}" title="Abrir seletor de cor"></button>
            <input id="cfg2-color-text" class="cfg2-input" type="text"
                   value="${esc(cor)}" placeholder="#00d0b7" data-key="loja_cor_primaria" maxlength="7">
          </div>
        </div>
      </div>`;
  }

  // ── Tab: Horários ──────────────────────────────────────────────────────
  function tabHorarios() {
    const rows = DIAS.map(d => {
      const ativo = s(`horario_${d.key}_ativo`, '0') === '1';
      const ab    = s(`horario_${d.key}_ab`, '08:00');
      const fe    = s(`horario_${d.key}_fe`, '22:00');
      return `
        <tr>
          <td class="cfg2-hor-dia${ativo ? ' ativo' : ''}" id="cfg2-hd-${d.key}">${d.label}</td>
          <td class="cfg2-hor-toggle-cell">
            <label class="cfg2-toggle">
              <input type="checkbox" id="cfg2-ht-${d.key}" data-key="horario_${d.key}_ativo" ${ativo ? 'checked' : ''}>
              <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
            </label>
          </td>
          <td>
            <div style="display:flex;align-items:center">
              <input type="time" class="cfg2-horarios-time" id="cfg2-hab-${d.key}"
                     value="${esc(ab)}" data-key="horario_${d.key}_ab" ${!ativo ? 'disabled' : ''}>
              <span class="cfg2-hor-sep">–</span>
              <input type="time" class="cfg2-horarios-time" id="cfg2-hfe-${d.key}"
                     value="${esc(fe)}" data-key="horario_${d.key}_fe" ${!ativo ? 'disabled' : ''}>
            </div>
          </td>
        </tr>`;
    }).join('');
    return `
      <div class="cfg2-section">
        <div class="cfg2-section-title">Horários de funcionamento</div>
        <table class="cfg2-horarios-table">
          <thead><tr>
            <th>Dia</th><th>Aberto</th><th>Horário</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Tab: Chaves de API ─────────────────────────────────────────────────
  function tabChaves() {
    const cards = [
      { id: 'gmaps',    key: 'google_maps_key',  label: 'Google Maps',  ph: 'AIzaSy...',     desc: 'Módulo Zonas de Entrega. Ative Maps JavaScript e Drawing no Google Cloud Console.' },
      { id: 'openai',   key: 'openai_key',        label: 'OpenAI',       ph: 'sk-...',        desc: 'Usado pelo assistente de atendimento via WhatsApp.' },
      { id: 'asaas',    key: 'asaas_key',         label: 'Asaas',        ph: '$aact_...',     desc: 'Pagamentos por PIX e cartão via Asaas.' },
      { id: 'telegram', key: 'telegram_token',    label: 'Telegram Bot', ph: '123456:ABC...', desc: 'Token do bot Telegram para notificações de pedidos.' },
    ];
    const hasToken = !!s('CEIA_NODE_TOKEN');
    return `
      <div class="cfg2-section">
        <div class="cfg2-section-title">Chaves e tokens de API</div>
        ${cards.map(c => {
          const hasKey = !!s(c.key);
          return `
            <div class="cfg2-api-card">
              <div class="cfg2-api-header">
                <span class="cfg2-api-name">${c.label}</span>
                <span class="cfg2-api-badge${hasKey ? ' ok' : ''}" id="cfg2-badge-${c.id}">
                  ${hasKey ? 'CONFIGURADO' : 'NÃO CONFIGURADO'}
                </span>
              </div>
              <p class="cfg2-api-desc">${c.desc}</p>
              <div class="cfg2-api-row">
                <input id="cfg2-key-${c.id}" class="cfg2-api-input" type="password"
                       placeholder="${c.ph}" data-key="${c.key}"
                       value="${hasKey ? '•'.repeat(24) : ''}">
                <button class="cfg2-icon-btn" data-show="${c.id}" title="Mostrar/ocultar">
                  <svg id="cfg2-eye-${c.id}" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                    <path d="M1 7c1.5-3.5 3.5-5 6-5s4.5 1.5 6 5c-1.5 3.5-3.5 5-6 5S2.5 10.5 1 7z"/>
                    <circle cx="7" cy="7" r="2"/>
                  </svg>
                </button>
                <button class="cfg2-btn-sm" data-save-key="${c.id}" data-key="${c.key}">Salvar</button>
                <button class="cfg2-btn-sm" data-test-key="${c.id}" data-tipo="${c.id}">Testar</button>
              </div>
            </div>`;
        }).join('')}
        <div class="cfg2-api-card">
          <div class="cfg2-api-header">
            <span class="cfg2-api-name">Token do nó (Vitrine)</span>
            <span class="cfg2-api-badge${hasToken ? ' ok' : ''}" id="cfg2-badge-vitrine-token">
              ${hasToken ? 'CONFIGURADO' : 'NÃO CONFIGURADO'}
            </span>
          </div>
          <p class="cfg2-api-desc">Conecta o CEIA OS à sua Vitrine Digital para sincronizar o cardápio automaticamente.</p>
          <div class="cfg2-api-row">
            <input id="cfg2-key-vitrine-token" class="cfg2-api-input" type="password"
                   placeholder="ceia_node_xxxxxxxxxxxxxxxx" data-key="CEIA_NODE_TOKEN"
                   value="${hasToken ? '•'.repeat(24) : ''}">
            <button class="cfg2-icon-btn" data-show="vitrine-token" title="Mostrar/ocultar">
              <svg id="cfg2-eye-vitrine-token" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M1 7c1.5-3.5 3.5-5 6-5s4.5 1.5 6 5c-1.5 3.5-3.5 5-6 5S2.5 10.5 1 7z"/>
                <circle cx="7" cy="7" r="2"/>
              </svg>
            </button>
            <button class="cfg2-btn-sm" id="cfg2-save-vitrine-token">Salvar</button>
            <button class="cfg2-btn-sm" id="cfg2-test-vitrine-token">Testar</button>
          </div>
        </div>
      </div>`;
  }

  // ── Tab: Comportamento IA ──────────────────────────────────────────────
  function tabIA() {
    const iaAtiva = s('ia_ativa', '1') === '1';
    const modelos = ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'];
    const tons    = [['amigavel','Amigável'],['formal','Formal'],['informal','Informal'],['profissional','Profissional']];
    return `
      <div class="cfg2-killswitch-row">
        <div>
          <div class="cfg2-killswitch-title">Assistente IA ativo</div>
          <div class="cfg2-killswitch-sub">Quando desativado, o bot não responde automaticamente</div>
        </div>
        <label class="cfg2-toggle">
          <input type="checkbox" data-key="ia_ativa" ${iaAtiva ? 'checked' : ''}>
          <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
        </label>
      </div>

      <div class="cfg2-section">
        <div class="cfg2-section-title">Modelo</div>
        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-ia-model">Modelo GPT</label>
          <select id="cfg2-ia-model" class="cfg2-select" data-key="ia_model">
            ${modelos.map(m => `<option value="${m}" ${s('ia_model','gpt-4o-mini') === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-ia-tom">Tom de comunicação</label>
          <select id="cfg2-ia-tom" class="cfg2-select" data-key="ia_tom">
            ${tons.map(([v,l]) => `<option value="${v}" ${s('ia_tom','amigavel') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-ia-limite">Limite msgs/sessão</label>
          <input id="cfg2-ia-limite" class="cfg2-input" type="number" min="1" max="200"
                 value="${esc(s('ia_limite_msgs','30'))}" data-key="ia_limite_msgs"
                 style="max-width:100px">
        </div>
      </div>

      <div class="cfg2-section">
        <div class="cfg2-section-title">Mensagens</div>
        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-ia-saudacao">Saudação inicial</label>
          <textarea id="cfg2-ia-saudacao" class="cfg2-textarea" rows="3"
                    placeholder="Mensagem enviada ao iniciar o atendimento"
                    data-key="ia_saudacao">${esc(s('ia_saudacao'))}</textarea>
        </div>
        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-ia-complementos">Instrução de adicionais</label>
          <textarea id="cfg2-ia-complementos" class="cfg2-textarea" rows="3"
                    placeholder="Como o bot deve sugerir adicionais e complementos"
                    data-key="ia_complementos">${esc(s('ia_complementos'))}</textarea>
        </div>
        <div class="cfg2-row">
          <label class="cfg2-label" for="cfg2-ia-cardapio-url">Link do cardápio</label>
          <input id="cfg2-ia-cardapio-url" class="cfg2-input" type="url"
                 placeholder="https://seu-restaurante.ceia.ia.br"
                 value="${esc(s('cardapio_url'))}" data-key="cardapio_url">
          <div class="cfg2-hint">Quando o cliente pedir o cardápio, a IA envia este link. Deixe vazio para listar categorias no chat.</div>
        </div>
      </div>`;
  }

  // ── Tab: Pagamentos ────────────────────────────────────────────────────
  function tabPagamentos() {
    const din         = s('pag_dinheiro',      '1') === '1';
    const cart        = s('pag_cartao',        '1') === '1';
    const pixDir      = s('pag_pix_direto',    '0') === '1';
    const cartOnline  = s('pag_cartao_online', '0') === '1';
    const asaasOn     = s('pag_asaas',         '0') === '1';
    const pixModo     = s('pix_modo', 'asaas');
    const asaasEnvVal = s('asaas_env', 'producao');
    const pixTipo  = s('pix_tipo',  'cpf');
    const pixChave = s('pix_chave', '');
    const tipos    = [['cpf','CPF'],['cnpj','CNPJ'],['email','E-mail'],['telefone','Telefone'],['aleatoria','Chave aleatória']];
    return `
      <div class="cfg2-section">
        <div class="cfg2-section-title">Formas de pagamento aceitas</div>

        <div class="cfg2-pay-row">
          <div>
            <div class="cfg2-pay-name">Dinheiro</div>
            <div class="cfg2-pay-sub">Pagamento em espécie na entrega</div>
          </div>
          <label class="cfg2-toggle">
            <input type="checkbox" data-key="pag_dinheiro" ${din ? 'checked' : ''}>
            <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
          </label>
        </div>

        <div class="cfg2-pay-row">
          <div>
            <div class="cfg2-pay-name">Cartão na entrega</div>
            <div class="cfg2-pay-sub">Maquininha levada pelo motoboy</div>
          </div>
          <label class="cfg2-toggle">
            <input type="checkbox" data-key="pag_cartao" ${cart ? 'checked' : ''}>
            <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
          </label>
        </div>

        <div class="cfg2-pay-row">
          <div>
            <div class="cfg2-pay-name">PIX direto</div>
            <div class="cfg2-pay-sub">Chave PIX exibida para o cliente pagar antes da entrega</div>
          </div>
          <label class="cfg2-toggle">
            <input type="checkbox" id="cfg2-pix-toggle" data-key="pag_pix_direto" ${pixDir ? 'checked' : ''}>
            <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
          </label>
        </div>
        <div class="cfg2-subsection${pixDir ? ' open' : ''}" id="cfg2-pix-sub">
          <div class="cfg2-subsection-title">Configuração PIX</div>
          <div class="cfg2-row" style="margin-bottom:12px">
            <label class="cfg2-label" for="cfg2-pix-tipo">Tipo de chave</label>
            <select id="cfg2-pix-tipo" class="cfg2-select" data-key="pix_tipo">
              ${tipos.map(([v,l]) => `<option value="${v}" ${pixTipo === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="cfg2-row" style="margin-bottom:0">
            <label class="cfg2-label" for="cfg2-pix-chave">Chave PIX</label>
            <input id="cfg2-pix-chave" class="cfg2-input" type="text"
                   value="${esc(pixChave)}" placeholder="Sua chave PIX" data-key="pix_chave">
          </div>
        </div>

        <div class="cfg2-pay-row">
          <div>
            <div class="cfg2-pay-name">Cartão online</div>
            <div class="cfg2-pay-sub">Link de pagamento por cartão de crédito (Asaas)</div>
          </div>
          <label class="cfg2-toggle">
            <input type="checkbox" data-key="pag_cartao_online" ${cartOnline ? 'checked' : ''}>
            <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
          </label>
        </div>

        <div class="cfg2-pay-row">
          <div>
            <div class="cfg2-pay-name">Asaas (PIX/Cartão online)</div>
            <div class="cfg2-pay-sub">Cobranças geradas automaticamente via API Asaas</div>
          </div>
          <label class="cfg2-toggle">
            <input type="checkbox" id="cfg2-asaas-toggle" data-key="pag_asaas" ${asaasOn ? 'checked' : ''}>
            <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
          </label>
        </div>
        <div class="cfg2-subsection${asaasOn ? ' open' : ''}" id="cfg2-asaas-sub">
          <div class="cfg2-subsection-title">Asaas</div>
          <p style="font-size:12px;color:var(--text-dim);letter-spacing:-0.01em;line-height:1.5">
            Configure a chave da API Asaas na aba
            <strong style="color:var(--text-muted)">Chaves de API</strong>.
          </p>
          <div class="cfg2-row" style="margin-top:12px;margin-bottom:12px">
            <label class="cfg2-label" for="cfg2-asaas-env">Ambiente</label>
            <select id="cfg2-asaas-env" class="cfg2-select" data-key="asaas_env">
              <option value="producao" ${asaasEnvVal === 'producao' ? 'selected' : ''}>Produção</option>
              <option value="sandbox"  ${asaasEnvVal === 'sandbox'  ? 'selected' : ''}>Sandbox (testes)</option>
            </select>
          </div>
          <div class="cfg2-row" style="margin-bottom:0">
            <label class="cfg2-label" for="cfg2-pix-modo">Modo PIX</label>
            <select id="cfg2-pix-modo" class="cfg2-select" data-key="pix_modo">
              <option value="asaas"  ${pixModo === 'asaas'  ? 'selected' : ''}>Asaas (link automático)</option>
              <option value="manual" ${pixModo === 'manual' ? 'selected' : ''}>Manual (exibe chave PIX)</option>
            </select>
          </div>
        </div>
      </div>`;
  }

  // ── Bind events per tab ────────────────────────────────────────────────
  function bindTabEvents(id) {
    if (id === 'restaurante') bindRestaurante();
    else if (id === 'horarios')   bindHorarios();
    else if (id === 'chaves')     bindChaves();
    else if (id === 'pagamentos') bindPagamentos();
    else if (id === 'whatsapp')   bindWhatsApp();
    else if (id === 'marketing')  bindMarketing();
  }

  function bindRestaurante() {
    // Logo upload
    document.getElementById('cfg2-logo-file')?.addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return window.Toast?.error('Imagem maior que 2 MB');
      const fd = new FormData();
      fd.append('logo', f);
      try {
        const r = await fetch(apiBase() + '/api/settings/logo', { method: 'POST', body: fd });
        const data = await r.json();
        if (data.ok && data.url) {
          const zone = document.getElementById('cfg2-logo-zone');
          if (zone) {
            zone.innerHTML = `<img src="${data.url}" alt="Logo" style="max-height:100%;max-width:100%;object-fit:contain">
              <input type="file" id="cfg2-logo-file" accept="image/png,image/jpeg" style="position:absolute;inset:0;opacity:0;cursor:pointer">`;
            document.getElementById('cfg2-logo-file')?.addEventListener('change', e => {
              const newF = e.target.files[0];
              if (newF) document.getElementById('cfg2-logo-file').dispatchEvent(Object.assign(new Event('change'), { target: { files: [newF] } }));
            });
          }
          _settings['loja_logo_url'] = data.url;
          window.Toast?.success('Logo enviado');
        } else {
          window.Toast?.error(data.error || 'Erro ao enviar logo');
        }
      } catch (ex) { window.Toast?.error('Erro: ' + ex.message); }
    });

    // CNPJ mask (on top of autosave, which fires on input)
    document.getElementById('cfg2-cnpj')?.addEventListener('input', e => {
      const pos = e.target.selectionStart;
      const masked = maskCNPJ(e.target.value);
      if (masked !== e.target.value) {
        e.target.value = masked;
        try { e.target.setSelectionRange(pos, pos); } catch (_) {}
      }
    });

    // Telefone mask
    document.getElementById('cfg2-telefone')?.addEventListener('input', e => {
      const pos = e.target.selectionStart;
      const masked = maskPhone(e.target.value);
      if (masked !== e.target.value) {
        e.target.value = masked;
        try { e.target.setSelectionRange(pos, pos); } catch (_) {}
      }
    });

    // Geocode button
    document.getElementById('cfg2-geocode-btn')?.addEventListener('click', async () => {
      const addr = document.getElementById('cfg2-endereco')?.value.trim();
      if (!addr) return window.Toast?.error('Informe o endereço primeiro');
      const btn = document.getElementById('cfg2-geocode-btn');
      btn.disabled = true; btn.textContent = 'Geocodificando...';
      try {
        const r = await fetch(apiBase() + '/api/settings/geocodificar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endereco: addr }),
        });
        const data = await r.json();
        if (data.ok) {
          const info = document.getElementById('cfg2-coords-info');
          if (info) info.textContent = `Coordenadas: ${data.lat}, ${data.lng}`;
          _settings['loja_lat'] = String(data.lat);
          _settings['loja_lng'] = String(data.lng);
          window.Toast?.success('Endereço geocodificado');
        } else { window.Toast?.error(data.error || 'Falha na geocodificação'); }
      } catch (ex) { window.Toast?.error('Erro: ' + ex.message); }
      finally { btn.disabled = false; btn.textContent = 'Geocodificar'; }
    });

    // Color picker
    const native     = document.getElementById('cfg2-color-native');
    const swatch     = document.getElementById('cfg2-color-swatch');
    const colorInput = document.getElementById('cfg2-color-text');
    swatch?.addEventListener('click', () => native?.click());
    native?.addEventListener('input', () => {
      if (colorInput) colorInput.value = native.value;
      if (swatch) swatch.style.background = native.value;
      autosave('loja_cor_primaria', native.value);
    });
    colorInput?.addEventListener('input', () => {
      const v = colorInput.value;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        if (swatch) swatch.style.background = v;
        if (native) native.value = v;
      }
    });
  }

  function bindHorarios() {
    DIAS.forEach(d => {
      document.getElementById(`cfg2-ht-${d.key}`)?.addEventListener('change', e => {
        const on = e.target.checked;
        document.getElementById(`cfg2-hd-${d.key}`)?.classList.toggle('ativo', on);
        const ab = document.getElementById(`cfg2-hab-${d.key}`);
        const fe = document.getElementById(`cfg2-hfe-${d.key}`);
        if (ab) ab.disabled = !on;
        if (fe) fe.disabled = !on;
        autosave(`horario_${d.key}_ativo`, on ? '1' : '0');
      });
    });
  }

  function bindChaves() {
    const content = document.getElementById('cfg2-content');
    if (!content) return;

    // Show/hide toggle
    content.querySelectorAll('[data-show]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id    = btn.dataset.show;
        const input = document.getElementById(`cfg2-key-${id}`);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
      });
    });

    // Save individual key
    content.querySelectorAll('[data-save-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id    = btn.dataset.saveKey;
        const key   = btn.dataset.key;
        const input = document.getElementById(`cfg2-key-${id}`);
        const val   = input?.value?.trim()?.replace(/•/g, '');
        if (!val) return window.Toast?.error('Informe a chave');
        btn.disabled = true;
        try {
          const r = await fetch(apiBase() + '/api/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: val }),
          });
          const data = await r.json();
          if (data.ok) {
            _settings[key] = val;
            if (input) { input.value = '•'.repeat(24); input.type = 'password'; }
            const badge = document.getElementById(`cfg2-badge-${id}`);
            if (badge) { badge.textContent = 'CONFIGURADO'; badge.className = 'cfg2-api-badge ok'; }
            window.Toast?.success('Chave salva');
          } else { window.Toast?.error(data.error || 'Erro ao salvar'); }
        } catch (ex) { window.Toast?.error('Erro: ' + ex.message); }
        finally { btn.disabled = false; }
      });
    });

    // Test key
    content.querySelectorAll('[data-test-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id    = btn.dataset.testKey;
        const tipo  = btn.dataset.tipo;
        const badge = document.getElementById(`cfg2-badge-${id}`);
        btn.disabled = true; btn.textContent = 'Testando...';
        try {
          const r    = await fetch(apiBase() + `/api/settings/testar/${tipo}`, { method: 'POST' });
          const data = await r.json();
          if (data.ok) {
            if (badge) { badge.textContent = 'OK'; badge.className = 'cfg2-api-badge ok'; }
            window.Toast?.success(data.msg || 'Conexão OK');
          } else {
            if (badge) { badge.textContent = 'ERRO'; badge.className = 'cfg2-api-badge err'; }
            window.Toast?.error(data.msg || data.error || 'Falha no teste');
          }
        } catch (ex) { window.Toast?.error('Erro: ' + ex.message); }
        finally { btn.disabled = false; btn.textContent = 'Testar'; }
      });
    });

    // Save token do nó (POST /api/vitrine/token — endpoint diferente dos outros)
    document.getElementById('cfg2-save-vitrine-token')?.addEventListener('click', async () => {
      const input = document.getElementById('cfg2-key-vitrine-token');
      const val   = input?.value?.trim()?.replace(/•/g, '');
      if (!val) return window.Toast?.error('Informe o token');
      const btn   = document.getElementById('cfg2-save-vitrine-token');
      btn.disabled = true;
      try {
        const r    = await fetch(apiBase() + '/api/vitrine/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: val }),
        });
        const data = await r.json();
        if (data.ok) {
          _settings['CEIA_NODE_TOKEN'] = val;
          if (input) { input.value = '•'.repeat(24); input.type = 'password'; }
          const badge = document.getElementById('cfg2-badge-vitrine-token');
          if (badge) { badge.textContent = 'CONFIGURADO'; badge.className = 'cfg2-api-badge ok'; }
          window.Toast?.success('Token salvo');
        } else { window.Toast?.error(data.error || 'Erro ao salvar token'); }
      } catch (ex) { window.Toast?.error('Erro: ' + ex.message); }
      finally { btn.disabled = false; }
    });

    // Testar token do nó (GET /api/vitrine/testar)
    document.getElementById('cfg2-test-vitrine-token')?.addEventListener('click', async () => {
      const badge = document.getElementById('cfg2-badge-vitrine-token');
      const btn   = document.getElementById('cfg2-test-vitrine-token');
      btn.disabled = true; btn.textContent = 'Testando...';
      try {
        const r    = await fetch(apiBase() + '/api/vitrine/testar');
        const data = await r.json();
        if (data.ok) {
          if (badge) { badge.textContent = 'OK'; badge.className = 'cfg2-api-badge ok'; }
          window.Toast?.success(data.msg || data.loja || 'Conectado');
        } else {
          if (badge) { badge.textContent = 'ERRO'; badge.className = 'cfg2-api-badge err'; }
          window.Toast?.error(data.error || 'Token inválido');
        }
      } catch (ex) { window.Toast?.error('Erro: ' + ex.message); }
      finally { btn.disabled = false; btn.textContent = 'Testar'; }
    });
  }

  function bindPagamentos() {
    document.getElementById('cfg2-pix-toggle')?.addEventListener('change', e => {
      document.getElementById('cfg2-pix-sub')?.classList.toggle('open', e.target.checked);
    });
    document.getElementById('cfg2-asaas-toggle')?.addEventListener('change', e => {
      document.getElementById('cfg2-asaas-sub')?.classList.toggle('open', e.target.checked);
    });
  }

  // ── Tab: WhatsApp ──────────────────────────────────────────────────────
  let _waPollingTimer = null;
  let _waLastStatus   = null;

  function tabWhatsApp() {
    return `
      <div class="cfg2-section" id="cfg2-wa-panel">
        <div class="cfg2-section-title">Conexão WhatsApp</div>
        <div id="cfg2-wa-body" style="display:flex;flex-direction:column;align-items:center;padding:32px 0;gap:20px">
          <div style="font-size:12px;color:var(--text-dim)">Carregando status…</div>
        </div>
      </div>`;
  }

  function _waRender(st) {
    const body = document.getElementById('cfg2-wa-body');
    if (!body) return;

    // Evita re-render se o status não mudou e não estamos aguardando QR
    if (_waLastStatus === st.status && st.status !== 'aguardando_qr') return;
    _waLastStatus = st.status;

    if (st.status === 'desconectado') {
      body.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-dim)">
          <path d="M38.5 8.5A22 22 0 0 0 2.5 24c0 3.8 1 7.4 2.8 10.5L2 46l11.8-3.1A22 22 0 1 0 38.5 8.5z"/>
          <path d="M16 19c0-4.4 7.1-4.4 7.1 0 0 3-3 3.8-3.5 7M19.5 30v1"/>
        </svg>
        <div style="font-size:14px;font-weight:600;color:var(--text);letter-spacing:-0.02em">WhatsApp não conectado</div>
        <div style="font-size:12px;color:var(--text-muted);text-align:center;max-width:320px;line-height:1.6">
          Conecte o WhatsApp da sua loja para receber e responder pedidos automaticamente.
        </div>
        <button id="cfg2-wa-conectar" class="dsp-btn" style="min-width:160px">Conectar WhatsApp</button>`;
      body.querySelector('#cfg2-wa-conectar')?.addEventListener('click', _waConectar);

    } else if (st.status === 'aguardando_qr') {
      body.innerHTML = `
        <div style="font-size:13px;font-weight:600;color:var(--text);letter-spacing:-0.02em">Escaneie o QR Code</div>
        <div style="font-size:11px;color:var(--text-muted);text-align:center;max-width:300px;line-height:1.5">
          Abra o WhatsApp no celular → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> → escaneie o código abaixo
        </div>
        ${st.qr
          ? `<img src="${st.qr}" width="250" height="250" style="border-radius:8px;background:#fff;padding:8px;border:1px solid var(--border)" alt="QR Code WhatsApp">`
          : `<div style="width:250px;height:250px;background:var(--surface);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-dim)">Gerando QR…</div>`
        }
        <div style="font-size:10px;color:var(--text-dim)">O código expira em alguns minutos. Se expirar, aguarde — um novo será gerado automaticamente.</div>
        <button id="cfg2-wa-cancelar" class="dsp-btn-ghost">Cancelar</button>`;
      body.querySelector('#cfg2-wa-cancelar')?.addEventListener('click', _waDesconectar);

    } else if (st.status === 'conectando') {
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="animation:spin 1s linear infinite">
            <path d="M9 2a7 7 0 0 1 7 7"/>
          </svg>
          <span style="font-size:13px;color:var(--text-muted)">Autenticando…</span>
        </div>`;

    } else if (st.status === 'conectado') {
      const desde = st.ultimaConexao
        ? new Date(st.ultimaConexao).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
        : '—';
      const num = st.numero || '';
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:14px 20px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);border-radius:8px;width:100%;max-width:400px;box-sizing:border-box">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 6.5L9 16.5l-5-5"/>
          </svg>
          <div>
            <div style="font-size:13px;font-weight:600;color:#22c55e">WhatsApp conectado</div>
            ${num ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">Número: +${num}</div>` : ''}
            <div style="font-size:11px;color:var(--text-dim)">Conectado desde: ${desde}</div>
          </div>
        </div>
        <div style="padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:6px;width:100%;max-width:400px;box-sizing:border-box">
          <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:4px">🛡️ Proteção anti-banimento ativa</div>
          <div style="font-size:11px;color:var(--text-muted);line-height:1.6">
            Por segurança, o sistema só responde a clientes que entrarem em contato primeiro. Isso protege o número da sua loja de banimento pelo WhatsApp.
          </div>
        </div>
        <button id="cfg2-wa-desconectar" class="dsp-btn-ghost danger" style="min-width:160px">Desconectar</button>`;
      body.querySelector('#cfg2-wa-desconectar')?.addEventListener('click', async () => {
        const ok = await window.Dialog?.confirm({
          title:       'Desconectar WhatsApp',
          message:     'Deseja desconectar o WhatsApp? A sessão será encerrada e você precisará escanear o QR novamente para reconectar.',
          confirmText: 'Desconectar',
          danger:      true,
        });
        if (ok) _waDesconectar();
      });

    } else if (st.status === 'erro') {
      body.innerHTML = `
        <div style="font-size:12px;color:#f87171;text-align:center;max-width:300px">Erro: ${esc(st.erro || 'Falha desconhecida')}</div>
        <button id="cfg2-wa-retry" class="dsp-btn" style="min-width:160px">Tentar de novo</button>`;
      body.querySelector('#cfg2-wa-retry')?.addEventListener('click', _waConectar);
    }
  }

  async function _waConectar() {
    try {
      await fetch(apiBase() + '/api/whatsapp/conectar', { method: 'POST' });
      _waLastStatus = null; // força re-render no próximo poll
    } catch (_) { window.Toast?.error('Erro ao iniciar conexão WhatsApp'); }
  }

  async function _waDesconectar() {
    try {
      await fetch(apiBase() + '/api/whatsapp/desconectar', { method: 'POST' });
      _waLastStatus = null;
    } catch (_) { window.Toast?.error('Erro ao desconectar WhatsApp'); }
  }

  async function _waPoll() {
    try {
      const r  = await fetch(apiBase() + '/api/whatsapp/status');
      const st = await r.json();
      _waRender(st);
      // Emite status para o indicador global da topbar
      document.dispatchEvent(new CustomEvent('wa:status', { detail: st }));
    } catch (_) {}
  }

  function bindWhatsApp() {
    // Poll imediato + a cada 3s enquanto na aba WhatsApp
    _waLastStatus = null;
    _waPoll();
    clearInterval(_waPollingTimer);
    _waPollingTimer = setInterval(_waPoll, 3000);
    // Para o polling ao sair da aba (bindTabNav já faz isso ao trocar de aba)
    document.getElementById('cfg2-tabs')?.addEventListener('click', () => {
      clearInterval(_waPollingTimer);
    }, { once: true });
  }

  // ── Marketing module ───────────────────────────────────────────────────────
  // State
  let _mktSubTab       = 'promocao';
  let _mktItems        = [];
  let _mktZonas        = [];
  let _mktEditing      = null;  // null = new, object = editing
  let _mktEligTimer    = null;
  let _mktSaving       = false;
  let _mktPendingImagem = null; // URL da imagem carregada no drawer atual

  const DIAS_SEMANA = [
    { k: 'seg', l: 'Seg' }, { k: 'ter', l: 'Ter' }, { k: 'qua', l: 'Qua' },
    { k: 'qui', l: 'Qui' }, { k: 'sex', l: 'Sex' }, { k: 'sab', l: 'Sáb' },
    { k: 'dom', l: 'Dom' },
  ];

  const BENEFICIO_TIPOS = [
    { v: 'frete_gratis',       l: 'Frete grátis' },
    { v: 'desconto_percentual', l: 'Desconto %' },
    { v: 'desconto_valor',      l: 'Desconto R$' },
  ];

  function _mktApi(path, opts = {}) {
    return fetch(apiBase() + path, opts).then(r => {
      if (!r.ok) return r.json().then(d => { throw new Error(d.error || r.statusText); });
      return r.json();
    });
  }
  function _mktJson(method, path, body) {
    return _mktApi(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ── Tab HTML shell ─────────────────────────────────────────────────────────
  function tabMarketing() {
    return `
      <div class="mkt-wrap">
        <div class="mkt-subtabs" id="mkt-subtabs">
          <button class="mkt-subtab ${_mktSubTab === 'promocao' ? 'active' : ''}" data-subtab="promocao">Promoções</button>
          <button class="mkt-subtab ${_mktSubTab === 'cupom'    ? 'active' : ''}" data-subtab="cupom">Cupons</button>
        </div>
        <div class="mkt-list-hdr">
          <span class="mkt-list-title" id="mkt-list-title">${_mktSubTab === 'promocao' ? 'Promoções' : 'Cupons'}</span>
          <button class="mkt-btn-new" id="mkt-btn-new">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/>
            </svg>
            ${_mktSubTab === 'promocao' ? 'Nova promoção' : 'Novo cupom'}
          </button>
        </div>
        <div id="mkt-list"><div class="mkt-loading">Carregando...</div></div>
      </div>
      <div class="mkt-backdrop" id="mkt-backdrop"></div>
      <div class="mkt-drawer" id="mkt-drawer"></div>`;
  }

  // ── Bind marketing tab ────────────────────────────────────────────────────
  async function bindMarketing() {
    // Load zonas + items in parallel
    try {
      [_mktZonas] = await Promise.all([
        _mktApi('/api/zonas').catch(() => []),
      ]);
    } catch (_) {}
    await _mktLoadItems();

    // Sub-tab clicks
    document.getElementById('mkt-subtabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.mkt-subtab');
      if (!btn) return;
      const sub = btn.dataset.subtab;
      if (sub === _mktSubTab) return;
      _mktSubTab = sub;
      document.querySelectorAll('.mkt-subtab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const title = document.getElementById('mkt-list-title');
      if (title) title.textContent = sub === 'promocao' ? 'Promoções' : 'Cupons';
      const newBtn = document.getElementById('mkt-btn-new');
      if (newBtn) newBtn.lastChild.textContent = sub === 'promocao' ? ' Nova promoção' : ' Novo cupom';
      _mktLoadItems();
    });

    // New button
    document.getElementById('mkt-btn-new')?.addEventListener('click', () => _mktOpenDrawer(null));

    // Stop WA polling when leaving marketing tab
    document.getElementById('cfg2-tabs')?.addEventListener('click', () => {
      _mktCloseDrawer();
    }, { once: true });
  }

  async function _mktLoadItems() {
    const list = document.getElementById('mkt-list');
    if (!list) return;
    list.innerHTML = '<div class="mkt-loading">Carregando...</div>';
    try {
      _mktItems = await _mktApi(`/api/marketing/promocoes?tipo=${_mktSubTab}`);
      _mktRenderList();
    } catch (e) {
      list.innerHTML = `<div class="mkt-empty">Erro ao carregar: ${esc(e.message)}</div>`;
    }
  }

  // ── List render ────────────────────────────────────────────────────────────
  function _mktRenderList() {
    const list = document.getElementById('mkt-list');
    if (!list) return;
    if (!_mktItems.length) {
      list.innerHTML = `<div class="mkt-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        Nenhum${_mktSubTab === 'cupom' ? ' cupom' : 'a promoção'} cadastrado${_mktSubTab === 'cupom' ? '' : 'a'} ainda.
      </div>`;
      return;
    }
    list.innerHTML = _mktItems.map(p => _mktCardHTML(p)).join('');
    list.querySelectorAll('.mkt-card-edit').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const item = _mktItems.find(p => p.id === Number(btn.dataset.id));
        if (item) _mktOpenDrawer(item);
      });
    });
    list.querySelectorAll('.mkt-card-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await _mktDelete(Number(btn.dataset.id));
      });
    });
    list.querySelectorAll('.mkt-card-toggle').forEach(tog => {
      tog.addEventListener('change', async e => {
        const id   = Number(tog.dataset.id);
        const ativ = tog.checked ? 1 : 0;
        try {
          await _mktJson('PUT', `/api/marketing/promocoes/${id}`, { ativa: ativ });
          const idx = _mktItems.findIndex(p => p.id === id);
          if (idx >= 0) _mktItems[idx].ativa = ativ;
          const card = tog.closest('.mkt-card');
          if (card) { ativ ? card.classList.remove('inactive') : card.classList.add('inactive'); }
        } catch (ex) { window.Toast?.error('Erro: ' + ex.message); tog.checked = !tog.checked; }
      });
    });
  }

  function _mktBeneficioLabel(p) {
    if (p.beneficio_tipo === 'frete_gratis') return 'Frete grátis';
    if (p.beneficio_tipo === 'desconto_percentual') return `${p.beneficio_valor ?? 0}% de desconto`;
    if (p.beneficio_tipo === 'desconto_valor') return `R$ ${Number(p.beneficio_valor ?? 0).toFixed(2).replace('.', ',')} de desconto`;
    return p.beneficio_tipo;
  }

  function _mktBadgeClass(tipo) {
    if (tipo === 'frete_gratis') return 'frete';
    if (tipo === 'desconto_percentual') return 'pct';
    return 'valor';
  }

  function _mktCardHTML(p) {
    const sub = p.codigo ? `Código: ${esc(p.codigo)} · ` : '';
    const isPub = p.visibilidade === 'publica';
    const elig = (!isPub && p.elegiveis_agora != null)
      ? `<span class="mkt-elig-pill"><strong>${p.elegiveis_agora}</strong> elegíveis</span>`
      : '';
    const visBadge = isPub
      ? '<span class="mkt-vis-badge pub">Pública</span>'
      : '<span class="mkt-vis-badge seg">Segmentada</span>';
    const thumb = p.imagem
      ? `<img class="mkt-card-thumb" src="${esc(p.imagem)}" alt="">`
      : '';
    return `
      <div class="mkt-card${p.ativa ? '' : ' inactive'}">
        ${thumb}
        <div class="mkt-card-info">
          <div class="mkt-card-name">${esc(p.nome)}</div>
          <div class="mkt-card-sub">${sub}${esc(_mktBeneficioLabel(p))}</div>
        </div>
        ${elig}
        ${visBadge}
        <span class="mkt-card-badge ${_mktBadgeClass(p.beneficio_tipo)}">${esc(_mktBeneficioLabel(p))}</span>
        <div class="mkt-card-actions">
          <label class="cfg2-toggle" title="${p.ativa ? 'Desativar' : 'Ativar'}">
            <input type="checkbox" class="mkt-card-toggle" data-id="${p.id}" ${p.ativa ? 'checked' : ''}>
            <span class="cfg2-toggle-track"><span class="cfg2-toggle-thumb"></span></span>
          </label>
          <button class="mkt-icon-btn mkt-card-edit" data-id="${p.id}" title="Editar">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M9.5 1.5l2 2-7 7H2.5v-2l7-7z"/>
            </svg>
          </button>
          <button class="mkt-icon-btn danger mkt-card-del" data-id="${p.id}" title="Excluir">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <polyline points="2,3 11,3"/><path d="M5,3V2h3v1"/><path d="M3,3l.6,8h5.8L10,3"/>
            </svg>
          </button>
        </div>
      </div>`;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function _mktDelete(id) {
    const item = _mktItems.find(p => p.id === id);
    if (!item) return;
    const ok = await window.Dialog?.confirm({
      title:       `Excluir ${_mktSubTab === 'cupom' ? 'cupom' : 'promoção'}`,
      message:     `Tem certeza que deseja excluir "${item.nome}"? Esta ação não pode ser desfeita.`,
      confirmText: 'Excluir',
      danger:      true,
    });
    if (!ok) return;
    try {
      await _mktApi(`/api/marketing/promocoes/${id}`, { method: 'DELETE' });
      _mktItems = _mktItems.filter(p => p.id !== id);
      _mktRenderList();
      window.Toast?.success('Excluído com sucesso');
    } catch (e) { window.Toast?.error('Erro: ' + e.message); }
  }

  // ── Drawer open / close ───────────────────────────────────────────────────
  function _mktOpenDrawer(item) {
    _mktEditing = item;
    _mktPendingImagem = item?.imagem || null;
    const drawer = document.getElementById('mkt-drawer');
    const backdrop = document.getElementById('mkt-backdrop');
    if (!drawer) return;
    drawer.innerHTML = _mktDrawerHTML(item);
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
      setTimeout(() => drawer.querySelector('#mkt-f-nome')?.focus(), 60);
    });
    _mktBindDrawer();
    _mktUpdateEligCount();  // initial count
  }

  let _mktEscHandler = null;
  function _mktCloseDrawer() {
    const drawer   = document.getElementById('mkt-drawer');
    const backdrop = document.getElementById('mkt-backdrop');
    if (drawer)   drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    _mktEditing = null;
    clearTimeout(_mktEligTimer);
    if (_mktEscHandler) { document.removeEventListener('keydown', _mktEscHandler); _mktEscHandler = null; }
  }

  // ── Drawer HTML ───────────────────────────────────────────────────────────
  function _mktDrawerHTML(item) {
    const tipo     = _mktSubTab;
    const isCupom  = tipo === 'cupom';
    const isNew    = !item;
    const v        = item || {};
    const benTipo  = v.beneficio_tipo || 'frete_gratis';
    const showVal  = benTipo !== 'frete_gratis';
    const excl     = Array.isArray(v.zonas_excluidas) ? v.zonas_excluidas : [];
    const fps      = Array.isArray(v.formas_pagamento) ? v.formas_pagamento : [];
    const diasSel  = Array.isArray(v.dias_semana) ? v.dias_semana : [];
    const vis      = v.visibilidade || 'segmentada';
    const isPub    = vis === 'publica';

    const zonaRows = _mktZonas.length
      ? _mktZonas.map(z => `
          <label class="mkt-zone-cb-row">
            <input type="checkbox" class="mkt-zone-cb" value="${esc(z.nome)}"
              ${excl.includes(z.nome) ? '' : 'checked'}>
            <span class="mkt-zone-cb-label">${esc(z.nome)}</span>
          </label>`).join('')
      : '<span style="font-size:11px;color:var(--text-dim)">Nenhuma zona cadastrada</span>';

    const pagOpts = ['Dinheiro', 'Cartão', 'Pix'];
    const pagRows = pagOpts.map(p => `
      <label class="mkt-cb-row">
        <input type="checkbox" class="mkt-pay-cb" value="${p}" ${fps.includes(p) ? 'checked' : ''}>
        <span class="mkt-cb-label">${p}</span>
      </label>`).join('');

    const diaRows = DIAS_SEMANA.map(d => `
      <label class="mkt-cb-row">
        <input type="checkbox" class="mkt-dia-cb" value="${d.k}" ${diasSel.includes(d.k) ? 'checked' : ''}>
        <span class="mkt-cb-label">${d.l}</span>
      </label>`).join('');

    const benRadios = BENEFICIO_TIPOS.map(bt => `
      <label class="mkt-radio-row">
        <input type="radio" name="mkt-ben-tipo" value="${bt.v}" ${benTipo === bt.v ? 'checked' : ''}>
        <span class="mkt-radio-label">${bt.l}</span>
      </label>`).join('');

    const imgAreaHTML = _mktPendingImagem
      ? `<div class="mkt-img-preview-wrap">
           <img class="mkt-img-preview" src="${esc(_mktPendingImagem)}" alt="preview">
           <button class="mkt-img-remove" id="mkt-img-remove" title="Remover imagem">×</button>
         </div>`
      : `<button class="mkt-img-btn" id="mkt-img-btn">+ Adicionar imagem</button>`;

    return `
      <div class="mkt-drawer-header">
        <span class="mkt-drawer-title">${isNew ? (isCupom ? 'Novo cupom' : 'Nova promoção') : esc(v.nome || '')}</span>
        <button class="mkt-drawer-close" id="mkt-drawer-close">×</button>
      </div>

      <div class="mkt-drawer-body">

        <!-- 0. VISIBILIDADE -->
        <div>
          <div class="mkt-section-title">Onde esta oferta aparece?</div>
          <div class="mkt-vis-options">
            <label class="mkt-vis-option${!isPub ? '' : ' selected'}" id="mkt-vis-pub-wrap">
              <input type="radio" name="mkt-vis" value="publica" ${isPub ? 'checked' : ''}>
              <div class="mkt-vis-option-content">
                <div class="mkt-vis-option-title">Pública — aparece na vitrine para todos</div>
                <div class="mkt-vis-option-desc">Visível para qualquer visitante do site. Critérios de cliente são ignorados.</div>
              </div>
            </label>
            <label class="mkt-vis-option${isPub ? '' : ' selected'}" id="mkt-vis-seg-wrap">
              <input type="radio" name="mkt-vis" value="segmentada" ${!isPub ? 'checked' : ''}>
              <div class="mkt-vis-option-content">
                <div class="mkt-vis-option-title">Segmentada — só no WhatsApp, para clientes elegíveis</div>
                <div class="mkt-vis-option-desc">O agente oferece apenas para clientes que cumprem os critérios abaixo. Não aparece na vitrine.</div>
              </div>
            </label>
          </div>
        </div>

        <!-- 1. BÁSICO -->
        <div>
          <div class="mkt-section-title">Básico</div>
          <div class="mkt-field">
            <label class="mkt-field-label">Nome *</label>
            <input id="mkt-f-nome" class="cfg2-input" style="width:100%" type="text"
              value="${esc(v.nome || '')}" placeholder="${isCupom ? 'Ex: 10% para clientes fiéis' : 'Ex: Frete Grátis Terça'}">
          </div>
          <div class="mkt-field mkt-codigo-field${isCupom ? ' visible' : ''}" id="mkt-codigo-wrap">
            <label class="mkt-field-label">Código do cupom *</label>
            <input id="mkt-f-codigo" class="cfg2-input" style="width:100%;text-transform:uppercase" type="text"
              value="${esc(v.codigo || '')}" placeholder="Ex: VOLTA10" maxlength="20">
            <div class="mkt-hint">O cliente informa este código no pedido para ativar o desconto.</div>
          </div>
          <div class="mkt-field">
            <label class="mkt-field-label">Descrição (opcional)</label>
            <textarea id="mkt-f-desc" class="cfg2-textarea" style="width:100%;min-height:56px"
              placeholder="Detalhes internos da promoção">${esc(v.descricao || '')}</textarea>
          </div>
          <div class="mkt-field">
            <label class="mkt-field-label">Imagem (opcional)</label>
            <div class="mkt-img-area" id="mkt-img-area">${imgAreaHTML}</div>
            <input type="file" id="mkt-img-input" accept="image/jpeg,image/png,image/webp" style="display:none">
          </div>
        </div>

        <!-- 2. BENEFÍCIO -->
        <div>
          <div class="mkt-section-title">Benefício</div>
          <div class="mkt-radio-group" id="mkt-ben-group">
            ${benRadios}
          </div>
          <div class="mkt-field" id="mkt-ben-valor-wrap" style="margin-top:12px;${showVal ? '' : 'display:none'}">
            <label class="mkt-field-label" id="mkt-ben-valor-label">${benTipo === 'desconto_percentual' ? 'Percentual (%)' : 'Valor (R$)'}</label>
            <input id="mkt-f-ben-valor" class="cfg2-input" style="width:120px" type="number"
              min="0" step="0.01" value="${v.beneficio_valor != null ? v.beneficio_valor : ''}">
          </div>
        </div>

        <!-- 3. ELEGIBILIDADE -->
        <div>
          <div class="mkt-section-title">Elegibilidade</div>

          <!-- Zonas — sempre ativa, pública ou segmentada -->
          <div class="mkt-elig-section" style="margin-bottom:16px">
            <div class="mkt-elig-title">Zonas de entrega</div>
            <div class="mkt-zones-hint">
              Por padrão todas as zonas participam. <strong>Desmarque</strong> as que <strong>NÃO</strong> devem receber esta ${isCupom ? 'promoção' : 'oferta'}.
            </div>
            <div class="mkt-zones-grid" id="mkt-zones-grid">
              ${zonaRows}
            </div>
          </div>

          <!-- Critérios de CLIENTE — desabilitados para promoção pública -->
          <div id="mkt-cliente-elig" class="mkt-cliente-elig${isPub ? ' disabled' : ''}">
            ${isPub ? `<div class="mkt-elig-pub-notice">Promoção pública — critérios de cliente não se aplicam.</div>` : ''}

            <!-- Critérios numéricos -->
            <div class="mkt-elig-section">
              <div class="mkt-elig-title">Histórico do cliente</div>
              <div class="mkt-hint" style="margin-bottom:12px">Campos em branco = sem restrição.</div>
              <div class="mkt-elig-row">
                <span class="mkt-elig-row-label">Mínimo de pedidos realizados</span>
                <input class="mkt-elig-input mkt-crit" id="mkt-c-min-ped" type="number" min="0" step="1"
                  value="${v.min_pedidos != null ? v.min_pedidos : ''}" placeholder="—">
              </div>
              <div class="mkt-elig-row">
                <span class="mkt-elig-row-label">Sem pedir há no mínimo (dias)</span>
                <input class="mkt-elig-input mkt-crit" id="mkt-c-dias-sem" type="number" min="0" step="1"
                  value="${v.dias_sem_pedir != null ? v.dias_sem_pedir : ''}" placeholder="—">
              </div>
              <div class="mkt-elig-row">
                <span class="mkt-elig-row-label">Total gasto mínimo (R$)</span>
                <input class="mkt-elig-input mkt-crit" id="mkt-c-gasto" type="number" min="0" step="0.01"
                  value="${v.min_total_gasto != null ? v.min_total_gasto : ''}" placeholder="—">
              </div>
              <div class="mkt-elig-row">
                <span class="mkt-elig-row-label">Ticket médio mínimo (R$)</span>
                <input class="mkt-elig-input mkt-crit" id="mkt-c-ticket" type="number" min="0" step="0.01"
                  value="${v.min_ticket_medio != null ? v.min_ticket_medio : ''}" placeholder="—">
              </div>
              <div class="mkt-elig-row">
                <span class="mkt-elig-row-label">Valor mínimo do pedido atual (R$)</span>
                <input class="mkt-elig-input mkt-crit" id="mkt-c-val-min" type="number" min="0" step="0.01"
                  value="${v.valor_minimo_pedido != null ? v.valor_minimo_pedido : ''}" placeholder="—">
              </div>
            </div>

            <!-- Formas de pagamento -->
            <div class="mkt-elig-section" style="margin-top:12px">
              <div class="mkt-elig-title">Forma de pagamento do cliente</div>
              <div class="mkt-hint" style="margin-bottom:10px">Vazio = qualquer forma de pagamento.</div>
              <div class="mkt-cb-grid" id="mkt-pay-grid">
                ${pagRows}
              </div>
            </div>
          </div>
        </div>

        <!-- 4. JANELA -->
        <div>
          <div class="mkt-section-title">Janela de validade (opcional)</div>
          <div class="mkt-hint" style="margin-bottom:12px">Sem seleção = válido todos os dias, o dia todo.</div>
          <div class="mkt-field">
            <label class="mkt-field-label">Dias da semana</label>
            <div class="mkt-cb-grid" id="mkt-dias-grid">
              ${diaRows}
            </div>
          </div>
          <div class="mkt-field" style="margin-top:12px">
            <label class="mkt-field-label">Horário de validade</label>
            <div class="mkt-time-row">
              <input class="mkt-time-input" id="mkt-f-h-ini" type="time"
                value="${esc(v.hora_inicio || '')}">
              <span class="mkt-time-sep">até</span>
              <input class="mkt-time-input" id="mkt-f-h-fim" type="time"
                value="${esc(v.hora_fim || '')}">
            </div>
          </div>
        </div>

      </div><!-- /body -->

      <div class="mkt-drawer-footer">
        <div class="mkt-elig-counter${isPub ? ' pub' : ' loading'}" id="mkt-elig-counter">
          ${isPub
            ? '<span>Promoção pública — visível para todos</span>'
            : '<strong>—</strong> clientes elegíveis agora'}
        </div>
        <div class="mkt-footer-actions">
          <button class="cfg2-btn-ghost" id="mkt-drawer-cancel">Cancelar</button>
          <button class="cfg2-btn" id="mkt-drawer-save">Salvar</button>
        </div>
      </div>`;
  }

  // ── Drawer bind ───────────────────────────────────────────────────────────
  function _mktBindDrawer() {
    // Close
    document.getElementById('mkt-drawer-close')?.addEventListener('click', _mktCloseDrawer);
    document.getElementById('mkt-drawer-cancel')?.addEventListener('click', _mktCloseDrawer);
    document.getElementById('mkt-backdrop')?.addEventListener('click', _mktCloseDrawer);

    // Esc fecha o drawer
    if (_mktEscHandler) document.removeEventListener('keydown', _mktEscHandler);
    _mktEscHandler = (e) => {
      if (e.key === 'Escape') _mktCloseDrawer();
    };
    document.addEventListener('keydown', _mktEscHandler);

    // Enter confirma (exceto em textarea e select)
    const drawer = document.getElementById('mkt-drawer');
    drawer?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON' && e.target.type !== 'checkbox' && e.target.type !== 'radio') {
        e.preventDefault();
        document.getElementById('mkt-drawer-save')?.click();
      }
    });

    // Visibilidade toggle
    document.querySelectorAll('input[name="mkt-vis"]').forEach(r => {
      r.addEventListener('change', () => {
        const isPub = r.value === 'publica';
        const clientElig = document.getElementById('mkt-cliente-elig');
        if (clientElig) {
          clientElig.classList.toggle('disabled', isPub);
          // show/hide the public notice
          let notice = clientElig.querySelector('.mkt-elig-pub-notice');
          if (isPub && !notice) {
            notice = document.createElement('div');
            notice.className = 'mkt-elig-pub-notice';
            notice.textContent = 'Promoção pública — critérios de cliente não se aplicam.';
            clientElig.prepend(notice);
          } else if (!isPub && notice) {
            notice.remove();
          }
        }
        const counter = document.getElementById('mkt-elig-counter');
        if (counter) {
          if (isPub) {
            counter.className = 'mkt-elig-counter pub';
            counter.innerHTML = '<span>Promoção pública — visível para todos</span>';
          } else {
            counter.className = 'mkt-elig-counter loading';
            counter.innerHTML = '<strong>—</strong> clientes elegíveis agora';
            _mktScheduleEligUpdate();
          }
        }
        // Update option highlight
        document.querySelectorAll('.mkt-vis-option').forEach(opt => {
          opt.classList.toggle('selected', opt.querySelector('input[name="mkt-vis"]')?.value === r.value);
        });
      });
    });

    // Benefício tipo → show/hide valor field
    document.querySelectorAll('input[name="mkt-ben-tipo"]').forEach(r => {
      r.addEventListener('change', () => {
        const tipo   = r.value;
        const wrap   = document.getElementById('mkt-ben-valor-wrap');
        const lbl    = document.getElementById('mkt-ben-valor-label');
        if (wrap) wrap.style.display = tipo === 'frete_gratis' ? 'none' : '';
        if (lbl) lbl.textContent = tipo === 'desconto_percentual' ? 'Percentual (%)' : 'Valor (R$)';
        _mktScheduleEligUpdate();
      });
    });

    // Eligibility criteria → debounce counter update
    document.querySelectorAll('.mkt-crit, .mkt-zone-cb, .mkt-pay-cb').forEach(el => {
      el.addEventListener('input', _mktScheduleEligUpdate);
      el.addEventListener('change', _mktScheduleEligUpdate);
    });

    // Other fields
    document.getElementById('mkt-f-nome')?.addEventListener('input', _mktScheduleEligUpdate);

    // Codigo uppercase
    document.getElementById('mkt-f-codigo')?.addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase();
    });

    // Image upload
    const imgInput = document.getElementById('mkt-img-input');
    document.getElementById('mkt-img-btn')?.addEventListener('click', () => imgInput?.click());
    document.getElementById('mkt-img-remove')?.addEventListener('click', () => {
      _mktPendingImagem = null;
      _mktRefreshImgArea();
    });
    if (imgInput) {
      imgInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const area = document.getElementById('mkt-img-area');
        if (area) area.innerHTML = '<span class="mkt-img-loading">Carregando...</span>';
        try {
          const fd = new FormData();
          fd.append('arquivo', file);
          const r = await fetch(apiBase() + '/api/uploads', { method: 'POST', body: fd });
          const d = await r.json();
          if (!d.ok) throw new Error(d.error || 'Falha no upload');
          _mktPendingImagem = d.url;
        } catch (ex) {
          window.Toast?.error('Erro no upload: ' + ex.message);
          _mktPendingImagem = null;
        }
        _mktRefreshImgArea();
      });
    }

    // Save
    document.getElementById('mkt-drawer-save')?.addEventListener('click', _mktSaveItem);
  }

  function _mktRefreshImgArea() {
    const area = document.getElementById('mkt-img-area');
    if (!area) return;
    if (_mktPendingImagem) {
      area.innerHTML = `<div class="mkt-img-preview-wrap">
        <img class="mkt-img-preview" src="${esc(_mktPendingImagem)}" alt="preview">
        <button class="mkt-img-remove" id="mkt-img-remove" title="Remover imagem">×</button>
      </div>`;
      document.getElementById('mkt-img-remove')?.addEventListener('click', () => {
        _mktPendingImagem = null;
        _mktRefreshImgArea();
      });
    } else {
      const imgInput = document.getElementById('mkt-img-input');
      area.innerHTML = `<button class="mkt-img-btn" id="mkt-img-btn">+ Adicionar imagem</button>`;
      document.getElementById('mkt-img-btn')?.addEventListener('click', () => imgInput?.click());
    }
  }

  function _mktScheduleEligUpdate() {
    clearTimeout(_mktEligTimer);
    _mktEligTimer = setTimeout(_mktUpdateEligCount, 500);
  }

  async function _mktUpdateEligCount() {
    const counter = document.getElementById('mkt-elig-counter');
    if (!counter) return;
    // Promoção pública não conta elegíveis
    const vis = document.querySelector('input[name="mkt-vis"]:checked')?.value;
    if (vis === 'publica') {
      counter.className = 'mkt-elig-counter pub';
      counter.innerHTML = '<span>Promoção pública — visível para todos</span>';
      return;
    }
    counter.className = 'mkt-elig-counter loading';
    counter.querySelector('strong').textContent = '…';
    try {
      const criterios = _mktReadCriterios();
      const { total } = await _mktJson('POST', '/api/marketing/promocoes/preview-elegiveis', criterios);
      if (!document.getElementById('mkt-elig-counter')) return; // drawer foi fechado
      counter.className = 'mkt-elig-counter';
      counter.querySelector('strong').textContent = total;
    } catch (_) {
      if (!document.getElementById('mkt-elig-counter')) return;
      counter.className = 'mkt-elig-counter';
      counter.querySelector('strong').textContent = '?';
    }
  }

  // Lê os critérios de elegibilidade do formulário atual
  function _mktReadCriterios() {
    const n = (id) => {
      const v = document.getElementById(id)?.value;
      return v !== '' && v != null ? Number(v) : null;
    };
    // Zonas: coleta as que estão DESMARCADAS → zonas_excluidas
    const zonasCbs = document.querySelectorAll('.mkt-zone-cb');
    const zonas_excluidas = [];
    zonasCbs.forEach(cb => { if (!cb.checked) zonas_excluidas.push(cb.value); });
    // Formas de pagamento: coleta as MARCADAS
    const payCbs = document.querySelectorAll('.mkt-pay-cb');
    const formas_pagamento = [];
    payCbs.forEach(cb => { if (cb.checked) formas_pagamento.push(cb.value); });

    return {
      min_pedidos:       n('mkt-c-min-ped'),
      dias_sem_pedir:    n('mkt-c-dias-sem'),
      min_total_gasto:   n('mkt-c-gasto'),
      min_ticket_medio:  n('mkt-c-ticket'),
      valor_minimo_pedido: n('mkt-c-val-min'),
      formas_pagamento:  formas_pagamento.length ? formas_pagamento : null,
      zonas_excluidas:   zonas_excluidas.length  ? zonas_excluidas  : null,
    };
  }

  // Lê todos os campos do formulário do drawer
  function _mktReadForm() {
    const benTipo = document.querySelector('input[name="mkt-ben-tipo"]:checked')?.value || 'frete_gratis';
    const diasCbs = document.querySelectorAll('.mkt-dia-cb');
    const dias_semana = [];
    diasCbs.forEach(cb => { if (cb.checked) dias_semana.push(cb.value); });

    const criterios = _mktReadCriterios();

    return {
      tipo:              _mktSubTab,
      nome:              document.getElementById('mkt-f-nome')?.value?.trim() || '',
      codigo:            document.getElementById('mkt-f-codigo')?.value?.trim().toUpperCase() || null,
      descricao:         document.getElementById('mkt-f-desc')?.value?.trim() || null,
      beneficio_tipo:    benTipo,
      beneficio_valor:   benTipo !== 'frete_gratis'
                           ? (Number(document.getElementById('mkt-f-ben-valor')?.value) || null)
                           : null,
      ...criterios,
      dias_semana:       dias_semana.length ? dias_semana : null,
      hora_inicio:       document.getElementById('mkt-f-h-ini')?.value || null,
      hora_fim:          document.getElementById('mkt-f-h-fim')?.value || null,
      visibilidade:      document.querySelector('input[name="mkt-vis"]:checked')?.value || 'segmentada',
      imagem:            _mktPendingImagem || null,
      ativa:             1,
    };
  }

  async function _mktSaveItem() {
    if (_mktSaving) return;
    const data = _mktReadForm();
    if (!data.nome) { window.Toast?.error('Informe o nome'); return; }
    if (_mktSubTab === 'cupom' && !data.codigo) { window.Toast?.error('Informe o código do cupom'); return; }
    if (data.beneficio_tipo !== 'frete_gratis' && (data.beneficio_valor == null || data.beneficio_valor <= 0)) {
      window.Toast?.error('Informe o valor do benefício'); return;
    }

    const saveBtn = document.getElementById('mkt-drawer-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Salvando...'; }
    _mktSaving = true;

    try {
      let saved;
      if (_mktEditing) {
        saved = await _mktJson('PUT', `/api/marketing/promocoes/${_mktEditing.id}`, data);
        const idx = _mktItems.findIndex(p => p.id === _mktEditing.id);
        // enriquece com elegiveis
        try { const { total } = await _mktJson('POST', '/api/marketing/promocoes/preview-elegiveis', data); saved.elegiveis_agora = total; } catch (_) {}
        if (idx >= 0) _mktItems[idx] = saved;
        else _mktItems.unshift(saved);
        window.Toast?.success('Promoção atualizada');
      } else {
        saved = await _mktJson('POST', '/api/marketing/promocoes', data);
        try { const { total } = await _mktJson('POST', '/api/marketing/promocoes/preview-elegiveis', data); saved.elegiveis_agora = total; } catch (_) {}
        _mktItems.unshift(saved);
        window.Toast?.success(_mktSubTab === 'cupom' ? 'Cupom criado' : 'Promoção criada');
      }
      _mktCloseDrawer();
      _mktRenderList();
    } catch (e) {
      window.Toast?.error('Erro: ' + e.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Salvar'; }
    } finally {
      _mktSaving = false;
    }
  }

  return { mount, unmount };
})();
