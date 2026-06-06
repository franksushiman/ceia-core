/**
 * Cardápio — Fase 3
 * Categorias (Fase 2) + Lista de Produtos com edição inline, upload, DnD, atalhos
 */
const Cardapio = (() => {
  /* ── State ──────────────────────────────────────────────────────────────── */
  const state = {
    categorias: [], selectedId: null, importando: false,
    produtos: [], loadingProdutos: false, focusedProductId: null, lastModifiedAt: null,
  };

  // Category DnD
  let _catDragSrcIdx = null;
  // Product DnD
  let _prodDragId  = null;
  let _prodDragIdx = null;
  // Dropdowns
  let _catDropEl    = null;
  let _catDropId    = null;
  let _prodDropEl   = null;
  let _prodDropId   = null;
  let _prodDropMove = false; // true when showing "mover" sub-list
  // Drawer (category)
  let _drawerCatId   = null;
  // Drawer (product)
  let _prodDrawerId  = null;
  // Drawer (adicionais)
  let _adicionaisGrupos = [];
  // Printer cache
  let _impCache     = null;
  let _impCacheTime = 0;
  // Preview
  let _previewVitrineUrl = null; // URL usada no iframe — mesma fonte do WhatsApp
  let _lastSyncAt        = null; // timestamp (ms) do último vitrine_atualizada via SSE
  let _previewSSE        = null;
  let _previewReload    = null; // debounce timer
  let _previewWaiting   = false;
  let _previewWaitTimer = null;
  let _syncTimeTimer    = null;
  let _reconcileTimer   = null; // polling de reconciliação (cinto de segurança)

  // Esgotado → vitrine sync feedback
  const _vitrineConfirmCbs  = {}; // prodId → callback chamado ao receber vitrine_atualizada
  const _vitrineBadgeTimers = {}; // prodId → timer de timeout/limpeza

  const DAYS = [
    { key: 'seg', label: 'Seg' }, { key: 'ter', label: 'Ter' },
    { key: 'qua', label: 'Qua' }, { key: 'qui', label: 'Qui' },
    { key: 'sex', label: 'Sex' }, { key: 'sab', label: 'Sáb' },
    { key: 'dom', label: 'Dom' },
  ];

  /* ── Helpers ─────────────────────────────────────────────────────────────── */
  function apiBase() { return (window.CEIA?.apiBase) || 'http://127.0.0.1:3000'; }
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  async function api(path, opts = {}) {
    const r = await fetch(apiBase() + path, opts);
    if (!r.ok) { const e = await r.json().catch(() => ({error: r.statusText})); throw new Error(e.error || r.statusText); }
    return r.json();
  }
  function json(method, path, body) {
    return api(path, {method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  }
  function formatPreco(v) {
    return 'R$ ' + (parseFloat(v) || 0).toFixed(2).replace('.', ',');
  }
  function parsePreco(s) {
    return parseFloat(String(s).replace('R$','').replace(/\s/g,'').replace(',','.')) || 0;
  }
  function relativeTime(ts) {
    if (!ts) return '';
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return 'editado agora';
    if (d < 3600) return `editado há ${Math.floor(d/60)}min`;
    return `editado há ${Math.floor(d/3600)}h`;
  }

  /* ── Data ────────────────────────────────────────────────────────────────── */
  async function loadCategorias() {
    const cats = await api('/api/categorias');
    const counts = await Promise.all(cats.map(c =>
      api(`/api/categorias/${c.id}/contar`).then(r => r.count).catch(() => 0)
    ));
    state.categorias = cats.map((c, i) => ({...c, _count: counts[i]}));
    if (state.selectedId && !state.categorias.find(c => c.id === state.selectedId)) state.selectedId = null;
    if (!state.selectedId && state.categorias.length > 0) state.selectedId = state.categorias[0].id;
    if (state.selectedId) {
      await loadProdutos(state.selectedId);
    } else {
      renderAll();
    }
  }

  async function loadProdutos(catId) {
    if (!catId) { state.produtos = []; renderAll(); return; }
    state.loadingProdutos = true;
    state.produtos = [];
    renderAll();
    try {
      state.produtos = await api(`/api/categorias/${catId}/produtos`);
    } catch(e) {
      window.Toast?.error('Erro ao carregar produtos: ' + e.message);
    }
    state.loadingProdutos = false;
    renderAll();
  }

  /* ── Renders ─────────────────────────────────────────────────────────────── */
  function renderAll() { renderCatList(); renderProdHeader(); renderProdArea(); }

  /* ──── Category list ──────────────────────────────────────────────────────── */
  function renderCatList() {
    const list = document.getElementById('cd-cat-list');
    if (!list) return;
    if (state.categorias.length === 0) {
      list.innerHTML = `<div class="cd-cat-empty-inner">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h4l2.5-3.5h7L20 7h4a1.5 1.5 0 011.5 1.5v14A1.5 1.5 0 0124 24H4a1.5 1.5 0 01-1.5-1.5v-14A1.5 1.5 0 014 7z"/>
          <line x1="14" y1="12" x2="14" y2="19"/><line x1="10.5" y1="15.5" x2="17.5" y2="15.5"/>
        </svg>
        <span>Nenhuma categoria ainda</span>
      </div>`;
      return;
    }
    list.innerHTML = state.categorias.map((cat, idx) => `
      <div class="cd-cat-item${cat.id === state.selectedId ? ' active' : ''}${cat.oculto ? ' cat-hidden' : ''}"
           data-id="${cat.id}" data-idx="${idx}" draggable="true">
        <span class="cd-drag-handle" title="Arrastar">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="3" cy="3"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="3"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="3" cy="7"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="7"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="3" cy="11" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="11" r=".5" fill="currentColor" stroke="none"/>
          </svg>
        </span>
        ${cat.oculto ? `<svg class="cd-hidden-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1l10 10M5 2.5A5 5 0 0111 6c-.4.7-1 1.4-1.7 1.9M3.5 3.5A5 5 0 001 6c1 1.7 2.8 3 5 3a5 5 0 002.2-.5"/></svg>` : ''}
        <span class="cd-cat-name" data-id="${cat.id}">${esc(cat.nome)}</span>
        <span class="cd-cat-count">${cat._count ?? 0}</span>
        <button class="cd-cat-gear-btn" data-id="${cat.id}" title="Configurações">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6.5" cy="6.5" r="1.8"/>
            <path d="M6.5 1v1.3M6.5 10.2V11.5M1 6.5h1.3M10.2 6.5H11.5M2.6 2.6l.9.9M9.5 9.5l.9.9M2.6 10.4l.9-.9M9.5 3.5l.9-.9"/>
          </svg>
        </button>
        <button class="cd-cat-menu-btn" data-id="${cat.id}" title="Mais opções">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" stroke="none">
            <circle cx="7" cy="3" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="7" cy="11" r="1.2"/>
          </svg>
        </button>
      </div>
    `).join('');
    bindCatListEvents();
  }

  function bindCatListEvents() {
    const list = document.getElementById('cd-cat-list');
    if (!list) return;
    list.onclick    = onCatListClick;
    list.ondblclick = onCatListDblClick;
    list.ondragstart = e => {
      if (_prodDragId !== null) return; // product drag takes precedence
      const item = e.target.closest('.cd-cat-item');
      if (!item) return;
      _catDragSrcIdx = parseInt(item.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    };
    list.ondragover = e => {
      e.preventDefault();
      if (_prodDragId !== null) {
        // Product being dragged → highlight category as target
        e.dataTransfer.dropEffect = 'move';
        const item = e.target.closest('.cd-cat-item');
        document.querySelectorAll('.cd-cat-item').forEach(el => el.classList.remove('cat-drag-target'));
        if (item) item.classList.add('cat-drag-target');
      } else {
        e.dataTransfer.dropEffect = 'move';
        const item = e.target.closest('.cd-cat-item');
        document.querySelectorAll('#cd-cat-list .cd-cat-item').forEach(el => el.classList.remove('drag-over'));
        if (item && parseInt(item.dataset.idx) !== _catDragSrcIdx) item.classList.add('drag-over');
      }
    };
    list.ondragleave = e => {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        document.querySelectorAll('.cd-cat-item').forEach(el =>
          el.classList.remove('drag-over', 'cat-drag-target')
        );
      }
    };
    list.ondrop = async e => {
      e.preventDefault();
      if (_prodDragId !== null) {
        // Drop product onto category → move
        const item = e.target.closest('.cd-cat-item');
        document.querySelectorAll('.cd-cat-item').forEach(el => el.classList.remove('cat-drag-target'));
        if (item) {
          const targetCatId = parseInt(item.dataset.id);
          if (targetCatId !== state.selectedId) {
            await moveProdToCategory(_prodDragId, targetCatId);
          }
        }
        _prodDragId = null;
        return;
      }
      // Category reorder
      const item = e.target.closest('.cd-cat-item');
      if (!item || _catDragSrcIdx === null) return;
      const destIdx = parseInt(item.dataset.idx);
      if (destIdx === _catDragSrcIdx) return;
      const prev = [...state.categorias];
      const next = [...state.categorias];
      const [moved] = next.splice(_catDragSrcIdx, 1);
      next.splice(destIdx, 0, moved);
      state.categorias = next;
      renderCatList();
      try {
        await json('POST', '/api/categorias/reorder', {ids: next.map(c => c.id)});
      } catch(err) {
        state.categorias = prev; renderCatList();
        window.Toast?.error('Falha ao reordenar');
      }
    };
    list.ondragend = () => {
      document.querySelectorAll('.cd-cat-item').forEach(el =>
        el.classList.remove('dragging', 'drag-over', 'cat-drag-target')
      );
      _catDragSrcIdx = null;
    };
  }

  function onCatListClick(e) {
    const gearBtn = e.target.closest('.cd-cat-gear-btn');
    if (gearBtn) { e.stopPropagation(); openCatDrawer(parseInt(gearBtn.dataset.id)); return; }
    const menuBtn = e.target.closest('.cd-cat-menu-btn');
    if (menuBtn) { e.stopPropagation(); openCatDropdown(menuBtn, parseInt(menuBtn.dataset.id)); return; }
    const item = e.target.closest('.cd-cat-item');
    if (item && !e.target.closest('.cd-drag-handle')) {
      selectCat(parseInt(item.dataset.id));
    }
  }

  async function selectCat(id) {
    if (id === state.selectedId) return;
    closeProdDropdown();
    state.selectedId = id;
    state.focusedProductId = null;
    renderCatList();
    await loadProdutos(id);
  }

  function onCatListDblClick(e) {
    const nameSpan = e.target.closest('.cd-cat-name');
    if (!nameSpan) return;
    startInlineCatEdit(nameSpan, parseInt(nameSpan.dataset.id));
  }

  function startInlineCatEdit(nameSpan, catId) {
    const original = nameSpan.textContent;
    const input = document.createElement('input');
    input.className = 'cd-inline-edit';
    input.value = original;
    nameSpan.replaceWith(input);
    input.focus(); input.select();
    async function save() {
      const val = input.value.trim();
      if (!val || val === original) { input.replaceWith(nameSpan); return; }
      try {
        const updated = await json('PATCH', `/api/categorias/${catId}`, {nome: val});
        const cat = state.categorias.find(c => c.id === catId);
        if (cat) cat.nome = updated.nome;
        renderAll();
      } catch(e) {
        input.replaceWith(nameSpan);
        window.Toast?.error('Erro ao renomear: ' + e.message);
      }
    }
    function cancel() { input.replaceWith(nameSpan); }
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') cancel(); };
    input.onblur = save;
  }

  /* ──── Category dropdown ──────────────────────────────────────────────────── */
  function getCatDropdown() {
    if (_catDropEl) return _catDropEl;
    _catDropEl = document.createElement('div');
    _catDropEl.id = 'cd-dropdown';
    _catDropEl.innerHTML = `
      <button data-action="settings">Configurações da categoria...</button>
      <div class="dd-sep"></div>
      <button data-action="rename">Renomear</button>
      <button data-action="duplicate">Duplicar</button>
      <button data-action="toggle-hidden" id="dd-toggle-hidden">Ocultar</button>
      <div class="dd-sep"></div>
      <button data-action="delete" class="dd-danger">Excluir</button>
    `;
    document.body.appendChild(_catDropEl);
    _catDropEl.onclick = onCatDropdownAction;
    document.addEventListener('click', closeCatDropdownOutside, true);
    return _catDropEl;
  }

  function openCatDropdown(btn, catId) {
    closeCatDropdown(); closeProdDropdown();
    _catDropId = catId;
    const cat = state.categorias.find(c => c.id === catId);
    const dd = getCatDropdown();
    const tb = dd.querySelector('#dd-toggle-hidden');
    if (tb) tb.textContent = cat?.oculto ? 'Mostrar' : 'Ocultar';
    const rect = btn.getBoundingClientRect();
    dd.style.top  = rect.bottom + 4 + 'px';
    dd.style.left = Math.min(rect.left, window.innerWidth - 170) + 'px';
    dd.classList.add('open');
  }

  function closeCatDropdown() {
    _catDropEl?.classList.remove('open');
    _catDropId = null;
  }

  function closeCatDropdownOutside(e) {
    if (_catDropEl && !_catDropEl.contains(e.target) && !e.target.closest('.cd-cat-menu-btn')) closeCatDropdown();
  }

  async function onCatDropdownAction(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = _catDropId;
    const cat = state.categorias.find(c => c.id === id);
    closeCatDropdown();
    if (!cat) return;
    if (action === 'settings') { openCatDrawer(id); return; }
    if (action === 'rename') {
      const nameSpan = document.querySelector(`.cd-cat-name[data-id="${id}"]`);
      if (nameSpan) startInlineCatEdit(nameSpan, id);
    }
    if (action === 'duplicate') {
      try {
        const nova = await json('POST', `/api/categorias/${id}/duplicar`, {});
        await loadCategorias();
        state.selectedId = nova.id;
        renderAll();
        window.Toast?.success(`"${nova.nome}" criada`);
      } catch(e) { window.Toast?.error('Falha ao duplicar: ' + e.message); }
    }
    if (action === 'toggle-hidden') {
      try {
        const updated = await json('PATCH', `/api/categorias/${id}`, {oculto: cat.oculto ? 0 : 1});
        cat.oculto = updated.oculto;
        renderAll();
      } catch(e) { window.Toast?.error('Falha: ' + e.message); }
    }
    if (action === 'delete') {
      const count = cat._count || 0;
      const sub = count > 0
        ? `Todos os ${count} produto(s) dentro dela também serão excluídos. Esta ação não pode ser desfeita.`
        : 'Esta ação não pode ser desfeita.';
      const ok = await window.Dialog?.confirm({
        title: `Excluir "${cat.nome}"`,
        message: sub,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/categorias/${id}`, {method:'DELETE'});
        state.categorias = state.categorias.filter(c => c.id !== id);
        if (state.selectedId === id) { state.selectedId = state.categorias[0]?.id ?? null; state.produtos = []; }
        renderAll();
        window.Toast?.success('Categoria excluída');
      } catch(e) { window.Toast?.error('Falha ao excluir: ' + e.message); }
    }
  }

  /* ──── Category drawer ───────────────────────────────────────────────────── */
  function openCatDrawer(catId) {
    closeCatDropdown(); closeProdDropdown();
    _drawerCatId = catId;
    const cat = state.categorias.find(c => c.id === catId);
    if (!cat) return;
    let drawer = document.querySelector('.cd-cat-drawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.className = 'cd-cat-drawer';
      const body = document.querySelector('.cd-body');
      if (body) body.appendChild(drawer);
    }
    drawer.innerHTML = drawerHTML(cat);
    bindDrawerEvents(drawer, cat);
    loadImpressoras(drawer);
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      setTimeout(() => drawer.querySelector('#cdd-nome')?.focus(), 60);
    });
  }

  function closeCatDrawer() {
    const drawer = document.querySelector('.cd-cat-drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    _drawerCatId = null;
    setTimeout(() => drawer.remove(), 270);
  }

  function drawerHTML(cat) {
    let horarios = {};
    try { horarios = cat.horarios ? JSON.parse(cat.horarios) : {}; } catch(_) {}
    const daysHtml = DAYS.map(d => {
      const h = horarios[d.key] || { ativo: false, abertura: '11:00', fechamento: '22:00' };
      return `
        <div class="cdd-day-row${h.ativo ? '' : ' cdd-day-disabled'}" data-day="${d.key}">
          <input type="checkbox" class="cdd-day-cb" data-day="${d.key}" ${h.ativo ? 'checked' : ''} id="cdd-day-${d.key}">
          <label class="cdd-day-name" for="cdd-day-${d.key}">${d.label}</label>
          <div class="cdd-day-times">
            <input type="time" class="cdd-time-input" data-day="${d.key}" data-which="abertura" value="${h.abertura || '11:00'}">
            <span class="cdd-time-sep">–</span>
            <input type="time" class="cdd-time-input" data-day="${d.key}" data-which="fechamento" value="${h.fechamento || '22:00'}">
          </div>
        </div>`;
    }).join('');
    return `
      <div class="cdd-header">
        <span class="cdd-title">Configurações da categoria</span>
        <button class="cdd-close-btn" id="cdd-close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </button>
      </div>
      <div class="cdd-body">
        <div class="cdd-group">
          <label class="cdd-label">Nome</label>
          <input type="text" class="cdd-input" id="cdd-nome" value="${esc(cat.nome)}" maxlength="60">
        </div>
        <div class="cdd-group">
          <label class="cdd-label">Descrição</label>
          <textarea class="cdd-textarea" id="cdd-desc" placeholder="Opcional — subtítulo na vitrine">${esc(cat.descricao || '')}</textarea>
        </div>
        <div class="cdd-sep"></div>
        <div class="cdd-group">
          <label class="cdd-label">Impressora padrão</label>
          <div class="cdd-select-wrap">
            <select class="cdd-select" id="cdd-impressora">
              <option value="">Carregando...</option>
            </select>
            <svg class="cdd-select-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
          </div>
        </div>
        <div class="cdd-sep"></div>
        <div class="cdd-group">
          <div class="cdd-toggle-row">
            <span class="cdd-toggle-label">Horários específicos</span>
            <label class="cdd-toggle">
              <input type="checkbox" class="cdd-toggle-input" id="cdd-horarios-toggle" ${cat.horarios_especificos ? 'checked' : ''}>
              <span class="cdd-toggle-track"></span>
            </label>
          </div>
          <div class="cdd-days-grid" id="cdd-days-grid" style="${cat.horarios_especificos ? '' : 'display:none'}">
            ${daysHtml}
          </div>
        </div>
      </div>
      <div class="cdd-footer">
        <button class="cdd-btn-cancel" id="cdd-cancel">Cancelar</button>
        <button class="cdd-btn-save" id="cdd-save">Salvar</button>
      </div>
    `;
  }

  function bindDrawerEvents(drawer, cat) {
    drawer.querySelector('#cdd-close').onclick  = closeCatDrawer;
    drawer.querySelector('#cdd-cancel').onclick = closeCatDrawer;
    const toggleEl = drawer.querySelector('#cdd-horarios-toggle');
    const daysGrid = drawer.querySelector('#cdd-days-grid');
    toggleEl.onchange = () => { daysGrid.style.display = toggleEl.checked ? '' : 'none'; };
    daysGrid.addEventListener('change', e => {
      const cb = e.target.closest('.cdd-day-cb');
      if (!cb) return;
      const row = cb.closest('.cdd-day-row');
      row.classList.toggle('cdd-day-disabled', !cb.checked);
    });
    drawer.querySelector('#cdd-save').onclick = () => saveDrawer(drawer, cat.id);
    // Enter salva (exceto em checkboxes/selects/textareas)
    drawer.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON' && e.target.type !== 'checkbox') {
        e.preventDefault();
        drawer.querySelector('#cdd-save')?.click();
      }
    });
  }

  async function loadImpressoras(drawer, force) {
    const sel = drawer.querySelector('#cdd-impressora');
    if (!sel) return;
    const now = Date.now();
    if (!force && _impCache && (now - _impCacheTime < 30000)) {
      renderImpressorasSelect(sel);
      return;
    }
    sel.innerHTML = '<option value="">Carregando...</option>';
    try {
      _impCache = await api('/api/impressoras');
      _impCacheTime = Date.now();
    } catch(_) { _impCache = []; }
    renderImpressorasSelect(sel);
  }

  function renderImpressorasSelect(sel) {
    const cat = state.categorias.find(c => c.id === _drawerCatId);
    const list = _impCache || [];
    sel.innerHTML = '<option value="">Nenhuma (padrão do sistema)</option>' +
      (list.length === 0
        ? '<option disabled>Nenhuma impressora encontrada</option>'
        : list.map(p => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join(''));
    if (cat?.impressora_id) sel.value = cat.impressora_id;
  }

  async function saveDrawer(drawer, catId) {
    const saveBtn = drawer.querySelector('#cdd-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Salvando...'; }
    const nome = drawer.querySelector('#cdd-nome').value.trim();
    if (!nome) {
      window.Toast?.error('Nome não pode ser vazio');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Salvar'; }
      return;
    }
    const descricao          = drawer.querySelector('#cdd-desc').value;
    const impressora_id      = drawer.querySelector('#cdd-impressora').value || null;
    const horarios_especificos = drawer.querySelector('#cdd-horarios-toggle').checked ? 1 : 0;
    const horarios = {};
    drawer.querySelectorAll('.cdd-day-row').forEach(row => {
      const day = row.dataset.day;
      const cb  = row.querySelector('.cdd-day-cb');
      const times = row.querySelectorAll('.cdd-time-input');
      horarios[day] = { ativo: cb.checked, abertura: times[0]?.value || '11:00', fechamento: times[1]?.value || '22:00' };
    });
    try {
      const updated = await json('PATCH', `/api/categorias/${catId}`, {
        nome, descricao, impressora_id, horarios_especificos, horarios: JSON.stringify(horarios),
      });
      const cat = state.categorias.find(c => c.id === catId);
      if (cat) Object.assign(cat, { nome: updated.nome, descricao: updated.descricao,
        impressora_id: updated.impressora_id, horarios_especificos: updated.horarios_especificos, horarios: updated.horarios });
      renderAll();
      closeCatDrawer();
      window.Toast?.success('Categoria atualizada');
    } catch(e) {
      window.Toast?.error('Falha ao salvar: ' + e.message);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Salvar'; }
    }
  }

  /* ──── Nova categoria ─────────────────────────────────────────────────────── */
  function startNewCat() {
    const list = document.getElementById('cd-cat-list');
    if (!list) return;
    // Guard: já existe um input de nova categoria aberto
    if (list.querySelector('.cd-inline-edit')) {
      list.querySelector('.cd-inline-edit').focus();
      list.querySelector('.cd-inline-edit').select();
      return;
    }
    list.querySelector('.cd-cat-empty-inner')?.remove();
    const tmp = document.createElement('div');
    tmp.className = 'cd-cat-item active';
    tmp.innerHTML = `<span class="cd-drag-handle"></span><input class="cd-inline-edit" value="Nova categoria" style="flex:1">`;
    list.appendChild(tmp);
    const input = tmp.querySelector('input');
    input.focus(); input.select();
    async function save() {
      const val = input.value.trim();
      if (!val) { tmp.remove(); if (state.categorias.length === 0) renderCatList(); return; }
      try {
        const cat = await json('POST', '/api/categorias', {nome: val});
        await loadCategorias();
        state.selectedId = cat.id;
        renderAll();
      } catch(e) {
        tmp.remove();
        if (state.categorias.length === 0) renderCatList();
        window.Toast?.error('Erro ao criar: ' + e.message);
      }
    }
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { tmp.remove(); if (state.categorias.length === 0) renderCatList(); }
    };
    input.onblur = save;
  }

  /* ──── Product header ─────────────────────────────────────────────────────── */
  function renderProdHeader() {
    const ht  = document.getElementById('cd-prod-h-title');
    const hs  = document.getElementById('cd-prod-h-sub');
    const btn = document.getElementById('cd-btn-novo-item');
    const cat = state.categorias.find(c => c.id === state.selectedId);
    if (cat) {
      if (ht) ht.textContent = cat.nome;
      const cnt = state.produtos.length;
      const ts = state.lastModifiedAt ? ' · ' + relativeTime(state.lastModifiedAt) : '';
      if (hs) hs.textContent = `${cnt} item${cnt !== 1 ? 's' : ''}${ts}`;
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
    } else {
      if (ht) ht.textContent = 'Selecione uma categoria';
      if (hs) hs.textContent = 'Crie sua primeira categoria para começar';
      if (btn) { btn.disabled = true; btn.style.opacity = '0.3'; btn.style.cursor = 'not-allowed'; }
    }
  }

  /* ──── Product area ───────────────────────────────────────────────────────── */
  function renderProdArea() {
    const area = document.getElementById('cd-prod-area');
    if (!area) return;
    const cat = state.categorias.find(c => c.id === state.selectedId);

    if (!cat) {
      area.innerHTML = `
        <div class="cd-prod-empty">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" style="color:var(--border-hover)">
            <rect x="10" y="16" width="60" height="48"/>
            <line x1="10" y1="30" x2="70" y2="30"/>
            <line x1="25" y1="16" x2="25" y2="30"/>
            <line x1="55" y1="16" x2="55" y2="30"/>
            <circle cx="40" cy="49" r="9"/>
            <line x1="40" y1="43" x2="40" y2="55"/><line x1="34" y1="49" x2="46" y2="49"/>
          </svg>
          <h3 id="cd-prod-empty-title">Nenhuma categoria selecionada</h3>
          <p id="cd-prod-empty-sub">Crie uma categoria à esquerda para adicionar produtos</p>
        </div>`;
      return;
    }

    if (state.loadingProdutos) {
      area.innerHTML = `<div class="cd-prod-loading">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round">
          <path d="M10 2a8 8 0 1 0 8 8" style="animation:cd-spin 0.8s linear infinite;transform-origin:10px 10px"/>
        </svg>
      </div>`;
      return;
    }

    if (state.produtos.length === 0) {
      area.innerHTML = `
        <div class="cd-prod-empty">
          <svg width="96" height="96" viewBox="0 0 96 96" fill="none" stroke="#cbd5e1" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
            <circle cx="48" cy="64" r="22"/>
            <path d="M26 56 Q48 34 70 56"/>
            <line x1="48" y1="42" x2="48" y2="26"/>
            <circle cx="48" cy="22" r="4"/>
            <line x1="36" y1="30" x2="30" y2="24"/>
            <line x1="60" y1="30" x2="66" y2="24"/>
          </svg>
          <h3 style="font-size:16px;font-weight:600;color:#475569;letter-spacing:-0.02em;margin-top:4px">
            Nenhum produto em ${esc(cat.nome)}
          </h3>
          <p style="font-size:13px;color:var(--text-muted);letter-spacing:-0.01em;margin-bottom:12px">
            Adicione produtos manualmente ou importe seu cardápio com IA
          </p>
          <div style="display:flex;gap:8px">
            <button class="cd-prod-btn-add-first" onclick="Cardapio._addNewProduto()">+ Adicionar produto</button>
            <button class="cd-prod-btn-import-ghost" onclick="Cardapio._openImportModal()">Importar com IA</button>
          </div>
        </div>`;
      return;
    }

    area.innerHTML = `<div class="cd-prod-list" id="cd-prod-list">
      ${state.produtos.map((p, i) => renderProdCard(p, i)).join('')}
    </div>`;
    bindProdListEvents();
  }

  /* ──── Product card ───────────────────────────────────────────────────────── */
  function renderProdCard(p, idx) {
    const isFocused  = state.focusedProductId === p.id;
    const isEsgotado = !!p.esgotado;
    const initial    = (p.nome || '?').charAt(0).toUpperCase();
    const thumbHtml  = p.foto_url
      ? `<img src="${esc(p.foto_url)}" alt="" class="cd-prod-thumb-img">`
      : `<div class="cd-prod-thumb-fallback" style="background:linear-gradient(135deg,#f1f5f9,#e2e8f0)">${initial}</div>`;
    return `
      <div class="cd-prod-card${isEsgotado ? ' cd-prod-card--esgotado' : ''}${isFocused ? ' cd-prod-card--focused' : ''}"
           data-id="${p.id}" data-idx="${idx}" draggable="true"
           tabindex="0">
        <div class="cd-prod-handle">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="3" cy="3"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="3"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="3" cy="7"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="7"  r=".5" fill="currentColor" stroke="none"/>
            <circle cx="3" cy="11" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="7" cy="11" r=".5" fill="currentColor" stroke="none"/>
          </svg>
        </div>
        <div class="cd-prod-thumb" data-prod-id="${p.id}">
          ${thumbHtml}
          ${isEsgotado ? '<div class="cd-prod-esgotado-badge">ESGOTADO</div>' : ''}
          <div class="cd-prod-thumb-overlay" style="display:none">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="white" stroke-width="2" stroke-linecap="round">
              <path d="M9 1a8 8 0 1 0 8 8" style="animation:cd-spin 0.8s linear infinite;transform-origin:9px 9px"/>
            </svg>
          </div>
          <input type="file" class="cd-prod-foto-input" accept="image/jpeg,image/png,image/webp" style="display:none" data-prod-id="${p.id}">
        </div>
        <div class="cd-prod-info">
          <div class="cd-prod-nome" data-field="nome" data-prod-id="${p.id}">${esc(p.nome)}</div>
          ${p.descricao
            ? `<div class="cd-prod-desc" data-field="descricao" data-prod-id="${p.id}">${esc(p.descricao)}</div>`
            : `<div class="cd-prod-desc-ph" data-field="descricao" data-prod-id="${p.id}">+ adicionar descrição</div>`
          }
        </div>
        <div class="cd-prod-preco-wrap">
          <span class="cd-prod-preco" data-field="preco" data-prod-id="${p.id}">${p.tem_variacoes && p.preco_min_var != null ? '<span class="cd-prod-preco-from">A partir de</span> ' + formatPreco(p.preco_min_var) : formatPreco(p.preco)}</span>
        </div>
        <div class="cd-prod-toggle-wrap">
          <label class="cd-prod-toggle" title="${isEsgotado ? 'Disponível' : 'Esgotado'}">
            <input type="checkbox" class="cd-prod-toggle-input" ${isEsgotado ? 'checked' : ''} data-prod-id="${p.id}">
            <span class="cd-prod-toggle-track"></span>
          </label>
          ${isEsgotado ? '<span class="cd-esgotado-label">Esgotado</span>' : ''}
        </div>
        <button class="cd-prod-details-btn" data-prod-id="${p.id}" title="Detalhes e variações">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6.5" cy="6.5" r="5.5"/>
            <line x1="6.5" y1="5.5" x2="6.5" y2="9.5"/>
            <circle cx="6.5" cy="3.5" r="0.6" fill="currentColor" stroke="none"/>
          </svg>
        </button>
        <button class="cd-prod-menu-btn" data-prod-id="${p.id}" title="Mais opções">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" stroke="none">
            <circle cx="7" cy="3" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="7" cy="11" r="1.2"/>
          </svg>
        </button>
      </div>`;
  }

  /* ──── Product list events ────────────────────────────────────────────────── */
  function bindProdListEvents() {
    const list = document.getElementById('cd-prod-list');
    if (!list) return;

    // Focus & click delegation
    list.addEventListener('click', onProdListClick);

    // Thumb click → file picker
    list.addEventListener('click', e => {
      const thumb = e.target.closest('.cd-prod-thumb');
      if (!thumb || e.target.closest('.cd-prod-menu-btn') || e.target.closest('.cd-prod-toggle')) return;
      const id = thumb.dataset.prodId;
      if (!id) return;
      const input = thumb.querySelector('.cd-prod-foto-input');
      if (input) input.click();
    });

    // File input change
    list.addEventListener('change', e => {
      const input = e.target.closest('.cd-prod-foto-input');
      if (!input || !input.files[0]) return;
      const id = parseInt(input.dataset.prodId);
      const thumb = input.closest('.cd-prod-thumb');
      uploadFoto(id, input.files[0], thumb);
    });

    // Toggle esgotado
    list.addEventListener('change', e => {
      const toggle = e.target.closest('.cd-prod-toggle-input');
      if (!toggle) return;
      const id = parseInt(toggle.dataset.prodId);
      const cardEl = toggle.closest('.cd-prod-card');
      patchEsgotado(id, toggle.checked ? 1 : 0, cardEl);
    });

    // Menu button
    list.addEventListener('click', e => {
      const btn = e.target.closest('.cd-prod-menu-btn');
      if (!btn) return;
      e.stopPropagation();
      openProdDropdown(btn, parseInt(btn.dataset.prodId));
    });

    // Drag and drop (product reorder + drag to category)
    list.addEventListener('dragstart', e => {
      const card = e.target.closest('.cd-prod-card');
      if (!card) return;
      _prodDragId  = parseInt(card.dataset.id);
      _prodDragIdx = parseInt(card.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('cd-prod-card--dragging'), 0);
    });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      if (_prodDragId === null) return;
      const card = e.target.closest('.cd-prod-card');
      document.querySelectorAll('.cd-prod-card').forEach(el => el.classList.remove('cd-prod-drag-over'));
      if (card && parseInt(card.dataset.id) !== _prodDragId) card.classList.add('cd-prod-drag-over');
    });
    list.addEventListener('dragleave', e => {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        document.querySelectorAll('.cd-prod-card').forEach(el => el.classList.remove('cd-prod-drag-over'));
      }
    });
    list.addEventListener('drop', async e => {
      e.preventDefault();
      const card = e.target.closest('.cd-prod-card');
      document.querySelectorAll('.cd-prod-card').forEach(el => el.classList.remove('cd-prod-drag-over'));
      if (!card || _prodDragId === null) return;
      const destIdx = parseInt(card.dataset.idx);
      if (destIdx === _prodDragIdx) return;
      // Reorder within category
      const prev = [...state.produtos];
      const next = [...state.produtos];
      const [moved] = next.splice(_prodDragIdx, 1);
      next.splice(destIdx, 0, moved);
      state.produtos = next;
      renderProdArea();
      try {
        await json('POST', '/api/produtos/reorder', {ids: next.map(p => p.id)});
        state.lastModifiedAt = Date.now();
        renderProdHeader();
      } catch(err) {
        state.produtos = prev; renderProdArea();
        window.Toast?.error('Falha ao reordenar');
      }
      _prodDragId = null; _prodDragIdx = null;
    });
    list.addEventListener('dragend', () => {
      document.querySelectorAll('.cd-prod-card').forEach(el =>
        el.classList.remove('cd-prod-card--dragging', 'cd-prod-drag-over')
      );
    });
  }

  function onProdListClick(e) {
    // Details button → open product drawer
    const detailsBtn = e.target.closest('.cd-prod-details-btn');
    if (detailsBtn) {
      e.stopPropagation();
      openProdDrawer(parseInt(detailsBtn.dataset.prodId));
      return;
    }
    // Inline field edit
    const field = e.target.dataset.field;
    const prodId = parseInt(e.target.dataset.prodId);
    if (field && prodId) {
      const cardEl = e.target.closest('.cd-prod-card');
      startEditProdField(cardEl, prodId, field, e.target);
      return;
    }
    // Focus card
    const card = e.target.closest('.cd-prod-card');
    if (card && !e.target.closest('input, textarea, button, label, .cd-prod-menu-btn, .cd-prod-details-btn')) {
      focusProd(parseInt(card.dataset.id));
    }
  }

  /* ──── Focus ─────────────────────────────────────────────────────────────── */
  function focusProd(id) {
    state.focusedProductId = id;
    document.querySelectorAll('.cd-prod-card').forEach(el => {
      el.classList.toggle('cd-prod-card--focused', parseInt(el.dataset.id) === id);
    });
  }

  /* ──── Inline edit ───────────────────────────────────────────────────────── */
  function startEditProdField(cardEl, prodId, field, triggerEl) {
    if (!cardEl) return;
    cardEl.classList.add('cd-prod-card--editing');
    const prod = state.produtos.find(p => p.id === prodId);
    if (!prod) return;

    if (field === 'nome') {
      const span = cardEl.querySelector(`[data-field="nome"]`);
      if (!span || span.tagName === 'INPUT') return;
      const original = prod.nome;
      const input = document.createElement('input');
      input.className = 'cd-prod-edit-input';
      input.value = original;
      span.replaceWith(input);
      input.focus(); input.select();
      const done = async (cancel) => {
        cardEl.classList.remove('cd-prod-card--editing');
        const val = input.value.trim();
        if (cancel || !val || val === original) {
          const newSpan = document.createElement('div');
          newSpan.className = 'cd-prod-nome';
          newSpan.dataset.field = 'nome'; newSpan.dataset.prodId = prodId;
          newSpan.textContent = original;
          input.replaceWith(newSpan);
          return;
        }
        const newSpan = document.createElement('div');
        newSpan.className = 'cd-prod-nome';
        newSpan.dataset.field = 'nome'; newSpan.dataset.prodId = prodId;
        newSpan.textContent = val;
        input.replaceWith(newSpan);
        await patchProd(prodId, {nome: val}, cardEl);
      };
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(false); } if (e.key === 'Escape') { e.preventDefault(); done(true); } };
      input.onblur = () => done(false);
    }

    else if (field === 'descricao') {
      const el = cardEl.querySelector(`[data-field="descricao"]`);
      if (!el || el.tagName === 'TEXTAREA') return;
      const original = prod.descricao || '';
      const ta = document.createElement('textarea');
      ta.className = 'cd-prod-edit-textarea';
      ta.value = original;
      el.replaceWith(ta);
      ta.focus(); ta.select();
      const done = async (cancel) => {
        cardEl.classList.remove('cd-prod-card--editing');
        const val = ta.value;
        if (cancel) {
          const newEl = makeDescEl(prodId, original);
          ta.replaceWith(newEl);
          return;
        }
        const newEl = makeDescEl(prodId, val.trim());
        ta.replaceWith(newEl);
        if (val.trim() !== original) {
          await patchProd(prodId, {descricao: val.trim()}, cardEl);
        }
      };
      ta.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); done(true); } };
      ta.onblur = () => done(false);
    }

    else if (field === 'preco') {
      const span = cardEl.querySelector(`[data-field="preco"]`);
      if (!span || span.tagName === 'INPUT') return;
      const original = prod.preco;
      const input = document.createElement('input');
      input.className = 'cd-prod-edit-input cd-prod-edit-preco';
      input.value = String(original).replace('.', ',');
      input.setAttribute('inputmode', 'decimal');
      span.replaceWith(input);
      input.focus(); input.select();
      const done = async (cancel) => {
        cardEl.classList.remove('cd-prod-card--editing');
        const val = parsePreco(input.value);
        const newSpan = document.createElement('span');
        newSpan.className = 'cd-prod-preco';
        newSpan.dataset.field = 'preco'; newSpan.dataset.prodId = prodId;
        newSpan.textContent = formatPreco(cancel ? original : val);
        input.replaceWith(newSpan);
        if (!cancel && val !== original) {
          await patchProd(prodId, {preco: val}, cardEl);
        }
      };
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(false); } if (e.key === 'Escape') { e.preventDefault(); done(true); } };
      input.onblur = () => done(false);
    }
  }

  function makeDescEl(prodId, text) {
    const el = document.createElement('div');
    if (text) {
      el.className = 'cd-prod-desc';
      el.textContent = text;
    } else {
      el.className = 'cd-prod-desc-ph';
      el.textContent = '+ adicionar descrição';
    }
    el.dataset.field = 'descricao';
    el.dataset.prodId = prodId;
    return el;
  }

  /* ──── Patch produto ─────────────────────────────────────────────────────── */
  async function patchProd(id, fields, cardEl, rerender) {
    try {
      await json('PATCH', `/api/produtos/${id}`, fields);
      const p = state.produtos.find(p => p.id === id);
      if (p) Object.assign(p, fields);
      state.lastModifiedAt = Date.now();
      if (rerender) {
        renderProdArea(); renderProdHeader();
      } else {
        flashCard(cardEl, 'ok');
        renderProdHeader();
      }
    } catch(e) {
      flashCard(cardEl, 'err');
      window.Toast?.error('Falha ao salvar: ' + e.message);
    }
  }

  function flashCard(cardEl, type) {
    if (!cardEl) return;
    cardEl.classList.remove('cd-prod-card--flash-ok', 'cd-prod-card--flash-err');
    void cardEl.offsetWidth; // reflow
    cardEl.classList.add(type === 'ok' ? 'cd-prod-card--flash-ok' : 'cd-prod-card--flash-err');
    setTimeout(() => cardEl.classList.remove('cd-prod-card--flash-ok', 'cd-prod-card--flash-err'), 400);
  }

  /* ──── Vitrine badge (esgotado sync feedback) ────────────────────────────── */
  function _vitrineBadge(cardEl, status, msg) {
    if (!cardEl) return;
    let b = cardEl.querySelector('.cd-vitrine-sync-badge');
    if (!b) {
      b = document.createElement('div');
      b.className = 'cd-vitrine-sync-badge';
      cardEl.appendChild(b);
    }
    b.dataset.status = status;
    b.textContent = msg;
  }

  function _vitrineBadgeClear(cardEl) {
    cardEl?.querySelector('.cd-vitrine-sync-badge')?.remove();
  }

  function _waitVitrineSyncConfirm(id, val, cardEl, attempt) {
    const MAX_ATTEMPTS = 3;
    const WAIT_MS = 10_000;

    clearTimeout(_vitrineBadgeTimers[id]);

    _vitrineConfirmCbs[id] = () => {
      delete _vitrineConfirmCbs[id];
      clearTimeout(_vitrineBadgeTimers[id]);
      delete _vitrineBadgeTimers[id];
      const label = val ? 'Pausado na vitrine' : 'Disponível na vitrine';
      _vitrineBadge(cardEl, 'ok', '✓ ' + label);
      _vitrineBadgeTimers[id] = setTimeout(() => {
        _vitrineBadgeClear(cardEl);
        delete _vitrineBadgeTimers[id];
      }, 3000);
    };

    _vitrineBadgeTimers[id] = setTimeout(async () => {
      delete _vitrineConfirmCbs[id];
      if (attempt < MAX_ATTEMPTS) {
        const n = attempt + 1;
        _vitrineBadge(cardEl, 'syncing', `Tentando... (${n}/${MAX_ATTEMPTS})`);
        try { await fetch(apiBase() + '/api/vitrine/sync', {method:'POST'}); } catch(_) {}
        _waitVitrineSyncConfirm(id, val, cardEl, n);
      } else {
        _vitrineBadge(cardEl, 'erro', '⚠ Vitrine offline — pausa salva localmente');
      }
    }, WAIT_MS);
  }

  async function patchEsgotado(id, val, cardEl) {
    try {
      await json('PATCH', `/api/produtos/${id}`, {esgotado: val});
    } catch(e) {
      flashCard(cardEl, 'err');
      window.Toast?.error('Falha ao salvar: ' + e.message);
      return;
    }
    const p = state.produtos.find(p => p.id === id);
    if (p) p.esgotado = val;
    state.lastModifiedAt = Date.now();
    renderProdArea(); renderProdHeader();

    // Vitrine feedback — busca cardEl atualizado após re-render (renderProdArea recria os elementos)
    const freshCardEl = document.querySelector(`.cd-prod-card[data-id="${id}"]`);
    _vitrineBadge(freshCardEl, 'syncing', 'Atualizando vitrine...');
    _waitVitrineSyncConfirm(id, val, freshCardEl, 0);
  }

  /* ──── Upload foto ───────────────────────────────────────────────────────── */
  async function uploadFoto(prodId, file, thumbEl) {
    const overlay = thumbEl?.querySelector('.cd-prod-thumb-overlay');
    if (overlay) overlay.style.display = 'flex';
    try {
      const fd = new FormData();
      fd.append('arquivo', file);
      const r = await fetch(apiBase() + '/api/uploads', {method:'POST', body: fd});
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Upload falhou');
      const cardEl = thumbEl?.closest('.cd-prod-card');
      await patchProd(prodId, {foto_url: data.url}, cardEl);
      window.Toast?.success('Foto atualizada');
      // Re-render the thumb area
      const p = state.produtos.find(p => p.id === prodId);
      if (p && thumbEl) {
        const img = thumbEl.querySelector('img, .cd-prod-thumb-fallback');
        if (img) {
          const newImg = document.createElement('img');
          newImg.src = data.url;
          newImg.className = 'cd-prod-thumb-img';
          img.replaceWith(newImg);
        }
      }
    } catch(e) {
      window.Toast?.error('Falha no upload: ' + e.message);
    } finally {
      if (overlay) overlay.style.display = 'none';
    }
  }

  /* ──── Add new produto ───────────────────────────────────────────────────── */
  function addNewProduto() {
    if (!state.selectedId) return;
    closeProdDropdown();
    const area = document.getElementById('cd-prod-area');
    if (!area) return;

    // Ensure list exists (category may be empty)
    let list = document.getElementById('cd-prod-list');
    if (!list) {
      area.innerHTML = `<div class="cd-prod-list" id="cd-prod-list"></div>`;
      list = document.getElementById('cd-prod-list');
      bindProdListEvents();
    }

    // Remove existing new-product row if any
    document.getElementById('cd-new-prod-row')?.remove();

    const row = document.createElement('div');
    row.id = 'cd-new-prod-row';
    row.className = 'cd-prod-card cd-prod-card--editing cd-new-row';
    row.innerHTML = `
      <div class="cd-prod-handle"></div>
      <div class="cd-prod-thumb">
        <div class="cd-prod-thumb-fallback cd-new-thumb">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>
        </div>
      </div>
      <div class="cd-prod-info">
        <input id="cd-new-prod-input" class="cd-prod-edit-input" placeholder="Nome do produto" style="width:100%">
        <div style="font-size:11px;color:var(--text-dim);letter-spacing:-0.01em;margin-top:4px">Enter para criar · Esc para cancelar</div>
      </div>
      <div class="cd-prod-preco-wrap">
        <span class="cd-prod-preco">R$ 0,00</span>
      </div>
      <div class="cd-prod-toggle-wrap"></div>
      <div style="width:32px"></div>
    `;
    list.insertBefore(row, list.firstChild);

    const input = row.querySelector('#cd-new-prod-input');
    input.focus();

    const cancel = () => { row.remove(); if (!list.children.length) renderProdArea(); };

    input.onkeydown = async e => {
      if (e.key === 'Escape') { cancel(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const nome = input.value.trim();
        if (!nome) { cancel(); return; }
        input.disabled = true;
        try {
          const body = {categoria_id: state.selectedId, nome, preco: 0};
          await json('POST', '/api/produtos', body);
          state.lastModifiedAt = Date.now();
          await loadProdutos(state.selectedId);
          window.Toast?.success('Produto criado');
        } catch(err) {
          input.disabled = false;
          window.Toast?.error('Erro ao criar: ' + err.message);
        }
      }
    };
    input.onblur = () => {
      // Small delay to allow Enter to fire first
      setTimeout(() => {
        if (document.getElementById('cd-new-prod-row')) cancel();
      }, 200);
    };
  }

  /* ──── Move product to category ──────────────────────────────────────────── */
  async function moveProdToCategory(prodId, catId) {
    try {
      await json('POST', `/api/produtos/${prodId}/mover`, {categoria_id: catId});
      state.produtos = state.produtos.filter(p => p.id !== prodId);
      state.lastModifiedAt = Date.now();
      // Update count for source and target categories
      await loadCategorias();
      window.Toast?.success('Produto movido');
    } catch(e) {
      window.Toast?.error('Falha ao mover: ' + e.message);
    }
  }

  /* ──── Product dropdown ──────────────────────────────────────────────────── */
  function getProdDropdown() {
    if (_prodDropEl) return _prodDropEl;
    _prodDropEl = document.createElement('div');
    _prodDropEl.id = 'cd-prod-dropdown';
    _prodDropEl.className = '';
    document.body.appendChild(_prodDropEl);
    document.addEventListener('click', closeProdDropdownOutside, true);
    return _prodDropEl;
  }

  function openProdDropdown(btn, prodId) {
    closeCatDropdown(); closeProdDropdown();
    _prodDropId   = prodId;
    _prodDropMove = false;
    const prod = state.produtos.find(p => p.id === prodId);
    const dd   = getProdDropdown();
    renderProdDropdownMain(dd, prod);
    const rect = btn.getBoundingClientRect();
    dd.style.top  = rect.bottom + 4 + 'px';
    dd.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
    dd.classList.add('open');
  }

  function renderProdDropdownMain(dd, prod) {
    _prodDropMove = false;
    dd.innerHTML = `
      <button data-pd-action="duplicar">Duplicar</button>
      <button data-pd-action="toggle-esgotado">${prod?.esgotado ? 'Marcar disponível' : 'Marcar esgotado'}</button>
      <button data-pd-action="mover">Mover para... ▶</button>
      <div class="dd-sep"></div>
      <button data-pd-action="excluir" class="dd-danger">Excluir</button>
    `;
    dd.onclick = onProdDropdownAction;
  }

  function renderProdDropdownMove(dd) {
    _prodDropMove = true;
    const outros = state.categorias.filter(c => c.id !== state.selectedId);
    dd.innerHTML = `
      <button data-pd-action="mover-back">← Voltar</button>
      <div class="dd-sep"></div>
      ${outros.length === 0
        ? '<button disabled style="opacity:0.4">Nenhuma outra categoria</button>'
        : outros.map(c => `<button data-pd-action="mover-cat" data-cat-id="${c.id}">${esc(c.nome)}</button>`).join('')
      }
    `;
    dd.onclick = onProdDropdownAction;
  }

  function closeProdDropdown() {
    _prodDropEl?.classList.remove('open');
    _prodDropId   = null;
    _prodDropMove = false;
  }

  function closeProdDropdownOutside(e) {
    if (_prodDropEl && !_prodDropEl.contains(e.target) && !e.target.closest('.cd-prod-menu-btn')) closeProdDropdown();
  }

  async function onProdDropdownAction(e) {
    const btn = e.target.closest('button[data-pd-action]');
    if (!btn) return;
    const action = btn.dataset.pdAction;
    const id     = _prodDropId;
    const prod   = state.produtos.find(p => p.id === id);

    if (action === 'mover-back') {
      renderProdDropdownMain(getProdDropdown(), prod);
      return;
    }
    if (action === 'mover') {
      renderProdDropdownMove(getProdDropdown());
      return;
    }
    if (action === 'mover-cat') {
      const catId = parseInt(btn.dataset.catId);
      closeProdDropdown();
      if (id && catId) await moveProdToCategory(id, catId);
      return;
    }

    closeProdDropdown();
    if (!prod) return;

    if (action === 'duplicar') {
      try {
        await api(`/api/produtos/${id}/duplicar`, {method:'POST'});
        state.lastModifiedAt = Date.now();
        await loadProdutos(state.selectedId);
        window.Toast?.success('Produto duplicado');
      } catch(e) { window.Toast?.error('Falha ao duplicar: ' + e.message); }
    }
    if (action === 'toggle-esgotado') {
      const cardEl = document.querySelector(`.cd-prod-card[data-id="${id}"]`);
      await patchEsgotado(id, prod.esgotado ? 0 : 1, cardEl);
    }
    if (action === 'excluir') {
      const ok = await window.Dialog?.confirm({
        title: 'Excluir produto',
        message: `Tem certeza que deseja excluir "${prod.nome}"? Esta ação não pode ser desfeita.`,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/produtos/${id}`, {method:'DELETE'});
        state.produtos = state.produtos.filter(p => p.id !== id);
        state.lastModifiedAt = Date.now();
        renderAll();
        window.Toast?.success('Produto excluído');
      } catch(e) { window.Toast?.error('Falha ao excluir: ' + e.message); }
    }
  }

  /* ──── Keyboard shortcuts ────────────────────────────────────────────────── */
  async function onKeyDown(e) {
    // ⌘K / Ctrl+K — foca a busca
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      document.querySelector('.cd-search-input')?.focus();
      return;
    }
    // Ctrl+Shift+N — new category (works regardless of focus)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
      if (e.repeat) return;
      e.preventDefault(); startNewCat(); return;
    }
    // Esc — close drawers if open (innermost first)
    if (e.key === 'Escape') {
      if (_prodDrawerId !== null)  { closeProdDrawer(); return; }
      if (_adicionaisGrupos !== null && document.querySelector('.cda-drawer.open')) { closeAdicionaisDrawer(); return; }
      if (_drawerCatId !== null)   { closeCatDrawer(); return; }
    }

    if (!state.focusedProductId) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    const idx  = state.produtos.findIndex(p => p.id === state.focusedProductId);
    const prod = state.produtos[idx];
    if (!prod) return;

    const cardEl = document.querySelector(`.cd-prod-card[data-id="${prod.id}"]`);

    if (e.key === 'Escape') { state.focusedProductId = null; document.querySelectorAll('.cd-prod-card--focused').forEach(el => el.classList.remove('cd-prod-card--focused')); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (idx < state.produtos.length - 1) { focusProd(state.produtos[idx+1].id); scrollProdIntoView(state.produtos[idx+1].id); } return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); if (idx > 0) { focusProd(state.produtos[idx-1].id); scrollProdIntoView(state.produtos[idx-1].id); } return; }
    if (e.key === 'Enter' || e.key === 'e' || e.key === 'E') { if (cardEl) startEditProdField(cardEl, prod.id, 'nome', null); return; }
    if (e.key === 'p' || e.key === 'P') { if (cardEl) startEditProdField(cardEl, prod.id, 'preco', null); return; }
    if (e.key === 'd' || e.key === 'D') {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); api(`/api/produtos/${prod.id}/duplicar`, {method:'POST'}).then(() => { state.lastModifiedAt = Date.now(); loadProdutos(state.selectedId); }).catch(()=>{}); }
      else if (cardEl) startEditProdField(cardEl, prod.id, 'descricao', null);
      return;
    }
    if (e.key === ' ') { e.preventDefault(); if (cardEl) patchEsgotado(prod.id, prod.esgotado ? 0 : 1, cardEl); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ok = await window.Dialog?.confirm({
        title: 'Excluir produto',
        message: `Tem certeza que deseja excluir "${prod.nome}"? Esta ação não pode ser desfeita.`,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/produtos/${prod.id}`, {method:'DELETE'});
        state.produtos = state.produtos.filter(p => p.id !== prod.id);
        state.focusedProductId = null;
        state.lastModifiedAt = Date.now();
        renderAll();
      } catch(err) { window.Toast?.error('Erro: ' + err.message); }
    }
  }

  function scrollProdIntoView(id) {
    setTimeout(() => {
      const el = document.querySelector(`.cd-prod-card[data-id="${id}"]`);
      el?.scrollIntoView({block:'nearest', behavior:'smooth'});
    }, 0);
  }

  /* ──── Import modal ──────────────────────────────────────────────────────── */
  function openImportModal() {
    if (document.getElementById('cd-import-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'cd-import-modal';
    modal.innerHTML = `
      <div class="cdm-backdrop"></div>
      <div class="cdm-card">
        <div class="cdm-header">
          <div>
            <h2>Importar cardápio com IA</h2>
            <p>Cole o texto, foto ou PDF do seu cardápio. A IA vai estruturar tudo automaticamente.</p>
          </div>
          <button class="cdm-close" id="cdm-close-btn">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>
          </button>
        </div>
        <div class="cdm-body">
          <div class="cdm-tabs">
            <button class="cdm-tab active" data-tab="texto">Texto</button>
            <button class="cdm-tab" data-tab="foto">Foto</button>
            <button class="cdm-tab" data-tab="pdf">PDF</button>
          </div>
          <div id="cdm-tab-texto" class="cdm-tab-panel active">
            <textarea id="cdm-textarea" placeholder="Cole aqui o texto do seu cardápio. Ex:&#10;&#10;Hambúrgueres&#10;X-Burguer — Pão, carne, queijo — R$ 22,90&#10;X-Salada — R$ 24,90&#10;&#10;Bebidas&#10;Coca-Cola lata — R$ 6,00"></textarea>
          </div>
          <div id="cdm-tab-foto" class="cdm-tab-panel">
            <div class="cdm-dropzone" id="cdm-foto-zone">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="28" height="20" rx="2"/><circle cx="10" cy="13" r="2.5"/><path d="M2 22l8-6 5 4 4-3 11 8"/></svg>
              <p>Arraste uma foto ou <label class="cdm-pick-label" for="cdm-foto-input">clique para escolher</label></p>
              <span class="cdm-pick-hint">JPG, PNG, WEBP — máx 10MB</span>
              <input type="file" id="cdm-foto-input" accept=".jpg,.jpeg,.png,.webp" style="display:none">
            </div>
            <div id="cdm-foto-preview" style="display:none">
              <img id="cdm-foto-img" style="max-height:180px;max-width:100%;border-radius:4px;display:block;margin:0 auto">
              <button class="cdm-trocar-btn" id="cdm-foto-trocar">Trocar imagem</button>
            </div>
          </div>
          <div id="cdm-tab-pdf" class="cdm-tab-panel">
            <div class="cdm-dropzone" id="cdm-pdf-zone">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 2H8a2 2 0 00-2 2v24a2 2 0 002 2h16a2 2 0 002-2V8z"/><polyline points="20 2 20 8 26 8"/><line x1="12" y1="15" x2="20" y2="15"/><line x1="12" y1="19" x2="20" y2="19"/><line x1="12" y1="23" x2="16" y2="23"/></svg>
              <p>Arraste um PDF ou <label class="cdm-pick-label" for="cdm-pdf-input">clique para escolher</label></p>
              <span class="cdm-pick-hint">máx 20MB</span>
              <input type="file" id="cdm-pdf-input" accept=".pdf" style="display:none">
            </div>
            <div id="cdm-pdf-info" style="display:none" class="cdm-file-info">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 2H5a1 1 0 00-1 1v14a1 1 0 001 1h10a1 1 0 001-1V6z"/><polyline points="13 2 13 6 17 6"/></svg>
              <span id="cdm-pdf-name"></span>
              <button class="cdm-trocar-btn" id="cdm-pdf-trocar">Trocar</button>
            </div>
          </div>
          <div id="cdm-error" class="cdm-error" style="display:none"></div>
        </div>
        <div class="cdm-footer">
          <button class="cdm-btn-cancel" id="cdm-cancel-btn">Cancelar</button>
          <button class="cdm-btn-import" id="cdm-import-btn" disabled>Importar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    let activeTab = 'texto';
    let fotoFile = null;
    let pdfFile = null;

    const importBtn = modal.querySelector('#cdm-import-btn');
    const cancelBtn = modal.querySelector('#cdm-cancel-btn');
    const textarea  = modal.querySelector('#cdm-textarea');
    const errorEl   = modal.querySelector('#cdm-error');

    function checkEnable() {
      if (activeTab === 'texto') importBtn.disabled = !textarea.value.trim();
      else if (activeTab === 'foto') importBtn.disabled = !fotoFile;
      else importBtn.disabled = !pdfFile;
    }

    modal.querySelectorAll('.cdm-tab').forEach(btn => btn.onclick = () => {
      modal.querySelectorAll('.cdm-tab').forEach(b => b.classList.remove('active'));
      modal.querySelectorAll('.cdm-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      modal.querySelector(`#cdm-tab-${activeTab}`).classList.add('active');
      checkEnable();
    });

    textarea.oninput = checkEnable;

    const fotoInput   = modal.querySelector('#cdm-foto-input');
    const fotoZone    = modal.querySelector('#cdm-foto-zone');
    const fotoPreview = modal.querySelector('#cdm-foto-preview');
    const fotoImg     = modal.querySelector('#cdm-foto-img');

    function setFoto(file) {
      fotoFile = file;
      fotoImg.src = URL.createObjectURL(file);
      fotoZone.style.display = 'none'; fotoPreview.style.display = 'block';
      checkEnable();
    }
    fotoInput.onchange = () => { if (fotoInput.files[0]) setFoto(fotoInput.files[0]); };
    modal.querySelector('#cdm-foto-trocar').onclick = () => {
      fotoFile = null; fotoZone.style.display = ''; fotoPreview.style.display = 'none';
      fotoInput.value = ''; checkEnable();
    };
    fotoZone.ondragover = e => { e.preventDefault(); fotoZone.classList.add('dz-over'); };
    fotoZone.ondragleave = () => fotoZone.classList.remove('dz-over');
    fotoZone.ondrop = e => { e.preventDefault(); fotoZone.classList.remove('dz-over'); if (e.dataTransfer.files[0]) setFoto(e.dataTransfer.files[0]); };

    const pdfInput = modal.querySelector('#cdm-pdf-input');
    const pdfZone  = modal.querySelector('#cdm-pdf-zone');
    const pdfInfo  = modal.querySelector('#cdm-pdf-info');
    const pdfName  = modal.querySelector('#cdm-pdf-name');

    function setPdf(file) {
      pdfFile = file; pdfName.textContent = file.name;
      pdfZone.style.display = 'none'; pdfInfo.style.display = 'flex';
      checkEnable();
    }
    pdfInput.onchange = () => { if (pdfInput.files[0]) setPdf(pdfInput.files[0]); };
    modal.querySelector('#cdm-pdf-trocar').onclick = () => {
      pdfFile = null; pdfZone.style.display = ''; pdfInfo.style.display = 'none';
      pdfInput.value = ''; checkEnable();
    };
    pdfZone.ondragover = e => { e.preventDefault(); pdfZone.classList.add('dz-over'); };
    pdfZone.ondragleave = () => pdfZone.classList.remove('dz-over');
    pdfZone.ondrop = e => { e.preventDefault(); pdfZone.classList.remove('dz-over'); if (e.dataTransfer.files[0]) setPdf(e.dataTransfer.files[0]); };

    function closeModal() { modal.remove(); state.importando = false; }
    modal.querySelector('#cdm-close-btn').onclick = closeModal;
    cancelBtn.onclick = closeModal;
    modal.querySelector('.cdm-backdrop').onclick = closeModal;

    importBtn.onclick = async () => {
      state.importando = true;
      importBtn.disabled = true;
      importBtn.textContent = 'Processando com IA...';
      cancelBtn.textContent = 'Continuar em background';
      errorEl.style.display = 'none';

      const fd = new FormData();
      if (activeTab === 'texto') fd.append('texto', textarea.value.trim());
      else if (activeTab === 'foto' && fotoFile) fd.append('arquivo', fotoFile);
      else if (activeTab === 'pdf'  && pdfFile)  fd.append('arquivo', pdfFile);

      try {
        const r = await fetch(apiBase() + '/api/cardapio/importar-ia', {method:'POST', body: fd});
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Erro desconhecido');
        closeModal();
        await loadCategorias();
        window.Toast?.success(`Importação concluída: ${data.categorias_criadas} categoria(s) e ${data.produtos_criados} produto(s)`);
      } catch(e) {
        state.importando = false;
        importBtn.disabled = false;
        importBtn.textContent = 'Importar';
        cancelBtn.textContent = 'Cancelar';
        errorEl.textContent = e.message;
        errorEl.style.display = 'block';
      }
    };
  }

  /* ──── Backdrop helper ───────────────────────────────────────────────────── */
  function getBackdrop(id) {
    let bd = document.getElementById(id);
    if (!bd) {
      bd = document.createElement('div');
      bd.id = id;
      bd.className = 'cd-drawer-backdrop';
      document.body.appendChild(bd);
    }
    return bd;
  }

  /* ──── Product Drawer (Part C) ───────────────────────────────────────────── */
  async function openProdDrawer(prodId) {
    closeProdDrawer();
    closeAdicionaisDrawer();
    closeCatDrawer();
    _prodDrawerId = prodId;

    const prod = state.produtos.find(p => p.id === prodId);
    if (!prod) return;

    const cat = state.categorias.find(c => c.id === state.selectedId);
    const [variacoes, todosAdicionais] = await Promise.all([
      api(`/api/produtos/${prodId}/variacoes`).catch(() => []),
      api('/api/cardapio/adicionais').catch(() => []),
    ]);

    let adicionaisGruposSelecionados = [];
    try { adicionaisGruposSelecionados = JSON.parse(prod.adicionais_grupos || '[]').map(Number); }
    catch(_) {}

    // Build drawer
    const drawer = document.createElement('div');
    drawer.className = 'cdp-drawer';
    drawer.id = 'cdp-prod-drawer';

    const adicionaisHtml = todosAdicionais.length === 0
      ? `<div style="font-size:12px;color:var(--text-dim);letter-spacing:-0.01em">Nenhum grupo de adicionais cadastrado. Crie em "Adicionais e Complementos".</div>`
      : todosAdicionais.map(a => {
          const sel = adicionaisGruposSelecionados.includes(a.id);
          return `<label class="cdp-add-item${sel ? ' selected' : ''}" data-add-id="${a.id}">
            <input type="checkbox" class="cdp-add-cb" ${sel ? 'checked' : ''} data-add-id="${a.id}">
            <span class="cdp-add-nome">${esc(a.nome)}</span>
            <span class="cdp-add-tipo">${a.tipo === 'unico' ? 'ÚNICO' : a.obrigatorio ? 'OBRIG' : 'OPCIONAL'}</span>
          </label>`;
        }).join('');

    const varHtml = variacoes.map((v, i) => `
      <div class="cdp-var-row" data-var-id="${v.id}" data-var-idx="${i}" draggable="true">
        <span class="cdp-var-handle">
          <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="2" cy="2" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="6" cy="2" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="2" cy="6" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="6" cy="6" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="2" cy="10" r=".5" fill="currentColor" stroke="none"/>
            <circle cx="6" cy="10" r=".5" fill="currentColor" stroke="none"/>
          </svg>
        </span>
        <input class="cdp-var-nome" value="${esc(v.nome)}" placeholder="Ex: Grande" data-var-id="${v.id}">
        <input class="cdp-var-preco" value="${(v.preco||0).toFixed(2).replace('.',',')}" placeholder="0,00" inputmode="decimal" data-var-id="${v.id}">
        <button class="cdp-var-del" data-var-id="${v.id}" title="Remover variação">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="10" y2="10"/><line x1="10" y1="1" x2="1" y2="10"/></svg>
        </button>
      </div>`).join('');

    const temVars  = !!(prod.tem_variacoes);
    const hasVars  = variacoes.length > 0;

    drawer.innerHTML = `
      <div class="cdp-header">
        <span class="cdp-title">Detalhes do produto</span>
        <button class="cdp-close" id="cdp-close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>
        </button>
      </div>
      <div class="cdp-body" id="cdp-body">

        <!-- 1. NOME -->
        <div class="cdp-group">
          <label class="cdp-label">Nome</label>
          <input class="cdp-input" id="cdp-nome" value="${esc(prod.nome)}" maxlength="100">
        </div>
        <div class="cdp-sep"></div>

        <!-- 2. PREÇO / TAMANHOS -->
        <div class="cdp-group">
          <div class="cdp-section-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <span class="cdp-section-title" id="cdp-preco-title">${temVars ? 'TAMANHOS' : 'PREÇO'}</span>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--text-muted);font-weight:500;letter-spacing:0.03em;user-select:none">
              <input type="checkbox" id="cdp-var-toggle" ${temVars ? 'checked' : ''} style="accent-color:#00d0b7;cursor:pointer">
              Tem tamanhos
            </label>
          </div>
          <!-- Preço único — visível quando NÃO tem variações -->
          <div id="cdp-preco-wrap" style="${temVars ? 'display:none' : ''}">
            <div class="cdp-row2">
              <div class="cdp-group">
                <label class="cdp-label">Preço (R$)</label>
                <input class="cdp-input" id="cdp-preco" value="${(prod.preco||0).toFixed(2).replace('.',',')}" inputmode="decimal">
              </div>
              <div class="cdp-group">
                <label class="cdp-label">Preço promo (R$)</label>
                <input class="cdp-input" id="cdp-preco-promo" value="${prod.preco_promocional ? (prod.preco_promocional).toFixed(2).replace('.',',') : ''}" placeholder="—" inputmode="decimal">
              </div>
            </div>
          </div>
          <!-- Lista de variações — visível quando TEM variações -->
          <div id="cdp-var-section" style="${temVars ? '' : 'display:none'}">
            <div class="cdp-var-list" id="cdp-var-list">${varHtml}</div>
            <button class="cdp-btn-add-var" id="cdp-btn-add-var">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="5.5" y1="1" x2="5.5" y2="10"/><line x1="1" y1="5.5" x2="10" y2="5.5"/></svg>
              Adicionar tamanho
            </button>
          </div>
        </div>
        <div class="cdp-sep"></div>

        <!-- 3. GRUPOS DE ADICIONAIS -->
        <div class="cdp-group">
          <label class="cdp-label">Grupos de adicionais</label>
          <div class="cdp-add-list" id="cdp-add-list">${adicionaisHtml}</div>
        </div>
        <div class="cdp-sep"></div>

        <!-- 4. DESCRIÇÃO + AI -->
        <div class="cdp-group">
          <label class="cdp-label">Descrição</label>
          <div class="cdp-ai-row">
            <textarea class="cdp-textarea" id="cdp-desc" rows="3" placeholder="Descrição do produto">${esc(prod.descricao || '')}</textarea>
            <button class="cdp-btn-ai" id="cdp-btn-ai" title="Gerar com IA">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1l1 2.2L10.5 4 8.5 6l.5 2.5L7 7.2 4.5 8.5 5 6 3 4l3.5-.8z"/></svg>
            </button>
          </div>
        </div>
        <div class="cdp-sep"></div>

        <!-- 5. FOTO (compacto) -->
        <div class="cdp-group">
          <label class="cdp-label">Foto</label>
          <div class="cdp-foto-wrap">
            <div class="cdp-foto-thumb cdp-foto-thumb-sm" id="cdp-foto-thumb" title="Trocar foto">
              ${prod.foto_url
                ? `<img src="${esc(prod.foto_url)}" alt="">`
                : `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="4" width="16" height="12" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l5-4 3 3 2-2 6 5"/></svg>`
              }
              <div class="cdp-foto-thumb-overlay" id="cdp-foto-overlay" style="display:none">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M10 2a8 8 0 1 0 8 8" style="animation:cd-spin 0.8s linear infinite;transform-origin:10px 10px"/></svg>
              </div>
            </div>
            <div class="cdp-foto-info">
              <button class="cdp-foto-btn" id="cdp-foto-btn">Trocar foto</button>
              ${prod.foto_url ? `<button class="cdp-foto-btn" id="cdp-foto-del" style="color:#ef4444;border-color:rgba(239,68,68,0.3)">Remover</button>` : ''}
              <span class="cdp-foto-hint">JPG, PNG, WEBP · máx 5MB</span>
            </div>
            <input type="file" id="cdp-foto-input" accept="image/jpeg,image/png,image/webp" style="display:none">
          </div>
        </div>

      </div>
      <div class="cdp-footer">
        <button class="cdp-btn-delete" id="cdp-btn-delete">Excluir</button>
        <button class="cdp-btn-save" id="cdp-btn-save">Salvar</button>
      </div>
    `;

    document.body.appendChild(drawer);
    const backdrop = getBackdrop('cdp-backdrop');
    backdrop.classList.add('open');
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      setTimeout(() => drawer.querySelector('#cdp-nome')?.focus(), 60);
    });

    // Wire events
    drawer.querySelector('#cdp-close').onclick = closeProdDrawer;
    backdrop.onclick = closeProdDrawer;

    // Photo
    const fotoThumb   = drawer.querySelector('#cdp-foto-thumb');
    const fotoInput   = drawer.querySelector('#cdp-foto-input');
    const fotoOverlay = drawer.querySelector('#cdp-foto-overlay');
    drawer.querySelector('#cdp-foto-btn').onclick = () => fotoInput.click();
    fotoThumb.onclick = () => fotoInput.click();
    drawer.querySelector('#cdp-foto-del')?.addEventListener('click', async () => {
      await patchProd(prodId, {foto_url: null}, null);
      const p = state.produtos.find(p => p.id === prodId);
      if (p) p.foto_url = null;
      fotoThumb.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="4" width="16" height="12" rx="1"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l5-4 3 3 2-2 6 5"/></svg>`;
      drawer.querySelector('#cdp-foto-del')?.remove();
    });
    fotoInput.onchange = async () => {
      if (!fotoInput.files[0]) return;
      if (fotoOverlay) fotoOverlay.style.display = 'flex';
      try {
        const fd = new FormData();
        fd.append('arquivo', fotoInput.files[0]);
        const r = await fetch(apiBase() + '/api/uploads', {method:'POST', body:fd});
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Upload falhou');
        await patchProd(prodId, {foto_url: data.url}, null);
        const p = state.produtos.find(p => p.id === prodId);
        if (p) p.foto_url = data.url;
        const img = document.createElement('img');
        img.src = data.url; img.alt = '';
        fotoThumb.innerHTML = '';
        fotoThumb.appendChild(img);
        fotoThumb.appendChild(fotoOverlay);
        window.Toast?.success('Foto atualizada');
      } catch(err) {
        window.Toast?.error('Falha no upload: ' + err.message);
      } finally {
        if (fotoOverlay) fotoOverlay.style.display = 'none';
      }
    };

    // AI description
    const btnAi = drawer.querySelector('#cdp-btn-ai');
    const descEl = drawer.querySelector('#cdp-desc');
    btnAi.onclick = async () => {
      btnAi.disabled = true;
      const nomeVal = drawer.querySelector('#cdp-nome').value.trim() || prod.nome;
      try {
        const data = await json('POST', '/api/ia/descricao', {nome: nomeVal, categoria: cat?.nome || ''});
        if (data.descricao) descEl.value = data.descricao;
      } catch(e) {
        window.Toast?.error('Falha ao gerar descrição: ' + e.message);
      } finally {
        btnAi.disabled = false;
      }
    };

    // Variações toggle — imediato (PATCH ao mudar)
    const varToggle  = drawer.querySelector('#cdp-var-toggle');
    const varSection = drawer.querySelector('#cdp-var-section');
    const precoWrap  = drawer.querySelector('#cdp-preco-wrap');
    const precoTitle = drawer.querySelector('#cdp-preco-title');
    varToggle.onchange = async () => {
      if (varToggle.checked) {
        // Ativar variações
        varSection.style.display = '';
        precoWrap.style.display  = 'none';
        if (precoTitle) precoTitle.textContent = 'TAMANHOS';
        await json('PATCH', `/api/produtos/${prodId}`, {tem_variacoes: 1}).catch(() => {});
        const p = state.produtos.find(p => p.id === prodId);
        if (p) p.tem_variacoes = 1;
      } else {
        // Desativar — confirmar se há variações
        const existingRows = varSection.querySelectorAll('.cdp-var-row');
        if (existingRows.length > 0) {
          const names = [...existingRows].map(r => r.querySelector('.cdp-var-nome')?.value).filter(Boolean);
          const ok = await window.Dialog?.confirm({
            title: 'Desativar variações',
            message: `Isso vai apagar ${names.length === 1 ? `"${names[0]}"` : `${names.length} tamanhos (${names.slice(0,2).join(', ')}${names.length > 2 ? '...' : ''})`}. Continuar?`,
            confirmText: 'Desativar e apagar',
            danger: true,
          });
          if (!ok) { varToggle.checked = true; return; }
          // Delete all variacoes
          for (const row of existingRows) {
            const vid = parseInt(row.dataset.varId);
            if (vid) await api(`/api/variacoes/${vid}`, {method:'DELETE'}).catch(() => {});
          }
          varSection.querySelector('#cdp-var-list').innerHTML = '';
        }
        varSection.style.display = 'none';
        precoWrap.style.display  = '';
        if (precoTitle) precoTitle.textContent = 'PREÇO';
        await json('PATCH', `/api/produtos/${prodId}`, {tem_variacoes: 0}).catch(() => {});
        const p = state.produtos.find(p => p.id === prodId);
        if (p) p.tem_variacoes = 0;
      }
    };

    // Variações add
    drawer.querySelector('#cdp-btn-add-var').onclick = async () => {
      try {
        const res = await json('POST', `/api/produtos/${prodId}/variacoes`, {nome: 'Nova variação', preco: 0});
        const v = res.variacao;
        const list = drawer.querySelector('#cdp-var-list');
        const row = document.createElement('div');
        row.className = 'cdp-var-row';
        row.dataset.varId  = v.id;
        row.dataset.varIdx = list.children.length;
        row.setAttribute('draggable', 'true');
        row.innerHTML = `
          <span class="cdp-var-handle"><svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="2" cy="2" r=".5" fill="currentColor" stroke="none"/><circle cx="6" cy="2" r=".5" fill="currentColor" stroke="none"/><circle cx="2" cy="6" r=".5" fill="currentColor" stroke="none"/><circle cx="6" cy="6" r=".5" fill="currentColor" stroke="none"/><circle cx="2" cy="10" r=".5" fill="currentColor" stroke="none"/><circle cx="6" cy="10" r=".5" fill="currentColor" stroke="none"/></svg></span>
          <input class="cdp-var-nome" value="${esc(v.nome)}" data-var-id="${v.id}">
          <input class="cdp-var-preco" value="0,00" inputmode="decimal" data-var-id="${v.id}">
          <button class="cdp-var-del" data-var-id="${v.id}" title="Remover">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="10" y2="10"/><line x1="10" y1="1" x2="1" y2="10"/></svg>
          </button>`;
        list.appendChild(row);
        row.querySelector('.cdp-var-nome').focus();
        row.querySelector('.cdp-var-nome').select();
      } catch(e) {
        window.Toast?.error('Erro: ' + e.message);
      }
    };

    // Variações events (delegate)
    const varList = drawer.querySelector('#cdp-var-list');
    let _varDragSrc = null;
    varList.addEventListener('click', async e => {
      const delBtn = e.target.closest('.cdp-var-del');
      if (delBtn) {
        const vid = parseInt(delBtn.dataset.varId);
        try {
          await api(`/api/variacoes/${vid}`, {method:'DELETE'});
          delBtn.closest('.cdp-var-row').remove();
        } catch(err) { window.Toast?.error('Erro: ' + err.message); }
      }
    });
    varList.addEventListener('blur', async e => {
      const input = e.target.closest('.cdp-var-nome, .cdp-var-preco');
      if (!input) return;
      const vid  = parseInt(input.dataset.varId);
      const row  = input.closest('.cdp-var-row');
      const nome = row.querySelector('.cdp-var-nome')?.value?.trim();
      const preco = parsePreco(row.querySelector('.cdp-var-preco')?.value || '0');
      if (!nome) return;
      try { await json('PATCH', `/api/variacoes/${vid}`, {nome, preco}); }
      catch(_) {}
    }, true);
    // Drag-reorder variações
    varList.addEventListener('dragstart', e => {
      const row = e.target.closest('.cdp-var-row');
      if (!row) return;
      _varDragSrc = row;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('cdp-var-dragging'), 0);
    });
    varList.addEventListener('dragover', e => {
      e.preventDefault();
      const row = e.target.closest('.cdp-var-row');
      varList.querySelectorAll('.cdp-var-row').forEach(r => r.classList.remove('cdp-var-over'));
      if (row && row !== _varDragSrc) row.classList.add('cdp-var-over');
    });
    varList.addEventListener('drop', async e => {
      e.preventDefault();
      const destRow = e.target.closest('.cdp-var-row');
      varList.querySelectorAll('.cdp-var-row').forEach(r => r.classList.remove('cdp-var-over'));
      if (!destRow || !_varDragSrc || destRow === _varDragSrc) return;
      const rows = [...varList.querySelectorAll('.cdp-var-row')];
      const srcIdx  = rows.indexOf(_varDragSrc);
      const destIdx = rows.indexOf(destRow);
      if (srcIdx < destIdx) destRow.after(_varDragSrc);
      else destRow.before(_varDragSrc);
      const newIds = [...varList.querySelectorAll('.cdp-var-row')].map(r => parseInt(r.dataset.varId));
      try { await json('POST', `/api/produtos/${prodId}/variacoes/reorder`, {ids: newIds}); }
      catch(_) {}
    });
    varList.addEventListener('dragend', () => {
      varList.querySelectorAll('.cdp-var-row').forEach(r => r.classList.remove('cdp-var-dragging', 'cdp-var-over'));
      _varDragSrc = null;
    });

    // Adicionais checkboxes
    const addList = drawer.querySelector('#cdp-add-list');
    addList?.addEventListener('change', e => {
      const cb = e.target.closest('.cdp-add-cb');
      if (!cb) return;
      const item = cb.closest('.cdp-add-item');
      item?.classList.toggle('selected', cb.checked);
    });

    // Save
    drawer.querySelector('#cdp-btn-save').onclick = async () => {
      const saveBtn = drawer.querySelector('#cdp-btn-save');
      saveBtn.disabled = true; saveBtn.textContent = 'Salvando...';
      const nome = drawer.querySelector('#cdp-nome').value.trim();
      if (!nome) {
        window.Toast?.error('Nome não pode ser vazio');
        saveBtn.disabled = false; saveBtn.textContent = 'Salvar';
        return;
      }
      const descricao = drawer.querySelector('#cdp-desc').value.trim() || null;
      // Only read preço when variações are NOT active (precoWrap is visible)
      const usandoVars = drawer.querySelector('#cdp-var-toggle')?.checked;
      const preco = usandoVars ? (prod.preco || 0) : parsePreco(drawer.querySelector('#cdp-preco').value);
      const precoPromoRaw = usandoVars ? '' : (drawer.querySelector('#cdp-preco-promo')?.value?.trim() || '');
      const preco_promocional = precoPromoRaw ? parsePreco(precoPromoRaw) : null;

      const checkedCbs = [...(addList?.querySelectorAll('.cdp-add-cb:checked') || [])];
      const adicionais_grupos = checkedCbs.map(cb => parseInt(cb.dataset.addId));

      try {
        await json('PATCH', `/api/produtos/${prodId}`, {nome, descricao, preco, preco_promocional, adicionais_grupos});
        const p = state.produtos.find(p => p.id === prodId);
        if (p) Object.assign(p, {nome, descricao, preco, preco_promocional, adicionais_grupos: JSON.stringify(adicionais_grupos)});
        state.lastModifiedAt = Date.now();
        renderAll();
        closeProdDrawer();
        window.Toast?.success('Produto atualizado');
      } catch(e) {
        window.Toast?.error('Falha: ' + e.message);
        saveBtn.disabled = false; saveBtn.textContent = 'Salvar';
      }
    };

    // Enter = salvar (exceto em textarea)
    drawer.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        drawer.querySelector('#cdp-btn-save')?.click();
      }
    });

    // Delete
    drawer.querySelector('#cdp-btn-delete').onclick = async () => {
      const ok = await window.Dialog?.confirm({
        title: 'Excluir produto',
        message: `Tem certeza que deseja excluir "${prod.nome}"? Esta ação não pode ser desfeita.`,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/produtos/${prodId}`, {method:'DELETE'});
        state.produtos = state.produtos.filter(p => p.id !== prodId);
        state.lastModifiedAt = Date.now();
        closeProdDrawer();
        renderAll();
        window.Toast?.success('Produto excluído');
      } catch(e) { window.Toast?.error('Falha: ' + e.message); }
    };
  }

  function closeProdDrawer() {
    const drawer = document.getElementById('cdp-prod-drawer');
    const backdrop = document.getElementById('cdp-backdrop');
    _prodDrawerId = null;
    if (drawer) {
      drawer.classList.remove('open');
      setTimeout(() => drawer.remove(), 260);
    }
    if (backdrop) backdrop.classList.remove('open');
  }

  /* ──── Adicionais Drawer (Part B) ────────────────────────────────────────── */
  async function openAdicionaisDrawer() {
    closeAdicionaisDrawer();
    closeProdDrawer();
    closeCatDrawer();

    let grupos;
    try {
      grupos = await api('/api/cardapio/adicionais');
      console.log('[CDA] grupos carregados:', grupos?.length, Array.isArray(grupos));
    } catch(e) {
      console.error('[CDA] falha ao buscar grupos:', e.message);
      grupos = [];
    }
    _adicionaisGrupos = grupos;

    const drawer = document.createElement('div');
    drawer.className = 'cda-drawer';
    drawer.id = 'cda-drawer';

    drawer.innerHTML = `
      <div class="cda-header">
        <span class="cda-title">Adicionais e Complementos</span>
        <button class="cda-close" id="cda-close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>
        </button>
      </div>
      <div class="cda-body" id="cda-body"></div>
      <div class="cda-footer">
        <button class="cda-btn-add-group" id="cda-btn-add">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="5.5" y1="1" x2="5.5" y2="10"/><line x1="1" y1="5.5" x2="10" y2="5.5"/></svg>
          Novo grupo
        </button>
        <button class="cda-footer-close" id="cda-close2">Fechar</button>
      </div>
    `;

    document.body.appendChild(drawer);

    const bodyEl = drawer.querySelector('#cda-body');
    try {
      bodyEl.innerHTML = renderAdicionaisGrupos(grupos);
      console.log('[CDA] body renderizado:', bodyEl.children.length, 'grupos');
    } catch(e) {
      console.error('[CDA] erro ao renderizar grupos:', e);
      bodyEl.innerHTML = `<div class="cda-empty">Erro ao carregar grupos: ${esc(e.message)}</div>`;
    }
    const backdrop = getBackdrop('cda-backdrop');
    backdrop.classList.add('open');
    requestAnimationFrame(() => drawer.classList.add('open'));

    drawer.querySelector('#cda-close').onclick  = closeAdicionaisDrawer;
    drawer.querySelector('#cda-close2').onclick = closeAdicionaisDrawer;
    backdrop.onclick = closeAdicionaisDrawer;

    drawer.querySelector('#cda-btn-add').onclick = async () => {
      try {
        // Create with 1 initial option so the group is immediately useful
        await json('POST', '/api/cardapio/adicionais', {
          nome: 'Novo grupo', tipo: 'multiplo', obrigatorio: 0, min_escolhas: 0, max_escolhas: 1,
          opcoes: [{ nome: 'Nova opção', preco: 0 }],
        });
        const fresh = await api('/api/cardapio/adicionais').catch(() => []);
        _adicionaisGrupos = fresh;
        document.getElementById('cda-body').innerHTML = renderAdicionaisGrupos(fresh);
        // NÃO re-registrar bindAdicionaisBodyEvents — o delegate registrado na montagem
        // permanece ativo no elemento #cda-body mesmo após innerHTML ser substituído.
        // Re-registrar acumularia listeners e dispararia N vezes por click.
        // Open the last group and autofocus the option nome input
        const groups = drawer.querySelectorAll('.cda-group');
        if (groups.length) {
          const lastGroup = groups[groups.length - 1];
          lastGroup.classList.add('open');
          // Scroll into view and focus the option input
          setTimeout(() => {
            const firstInput = lastGroup.querySelector('.cda-opcao-nome');
            if (firstInput) { firstInput.focus(); firstInput.select(); }
            lastGroup.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 50);
        }
      } catch(e) { window.Toast?.error('Erro: ' + e.message); }
    };

    bindAdicionaisBodyEvents(drawer);
  }

  function renderAdicionaisGrupos(grupos) {
    if (!grupos.length) {
      return `<div class="cda-empty">Nenhum grupo cadastrado ainda.<br>Clique em "Novo grupo" para começar.</div>`;
    }
    return grupos.map(g => `
      <div class="cda-group" data-add-id="${g.id}">
        <div class="cda-group-header" data-toggle="${g.id}">
          <svg class="cda-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 2l4 3-4 3"/></svg>
          <input class="cda-group-nome" value="${esc(g.nome)}" data-add-id="${g.id}">
          <div class="cda-group-badges">
            ${g.obrigatorio ? '<span class="cda-badge obrig">OBRIG</span>' : '<span class="cda-badge">OPC</span>'}
            <span class="cda-badge">${g.tipo === 'unico' ? '1' : `≤${g.max_escolhas}`}</span>
          </div>
          <button class="cda-group-menu" data-add-id="${g.id}" title="Opções">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" stroke="none"><circle cx="6" cy="2" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="10" r="1"/></svg>
          </button>
        </div>
        <div class="cda-group-body">
          <div class="cda-meta-row">
            <span class="cda-meta-label">Tipo:</span>
            <select class="cda-select" data-add-id="${g.id}" data-field="tipo">
              <option value="multiplo" ${g.tipo==='multiplo'?'selected':''}>Múltipla escolha</option>
              <option value="unico"    ${g.tipo==='unico'?'selected':''}>Escolha única</option>
            </select>
            <span class="cda-meta-label">Máx:</span>
            <input type="number" class="cda-num-input" value="${g.max_escolhas||1}" min="1" data-add-id="${g.id}" data-field="max_escolhas">
            <div class="cda-obrig-toggle">
              <input type="checkbox" id="cda-ob-${g.id}" ${g.obrigatorio?'checked':''} data-add-id="${g.id}" data-field="obrigatorio">
              <label for="cda-ob-${g.id}">Obrigatório</label>
            </div>
          </div>
          <div class="cda-opcoes-list" data-opcoes-for="${g.id}">
            ${(g.opcoes||[]).map(op => `
              <div class="cda-opcao-row" data-op-id="${op.id}">
                <input class="cda-opcao-nome" value="${esc(op.nome)}" placeholder="Nome da opção" data-op-id="${op.id}">
                <input class="cda-opcao-preco" value="${(op.preco||0).toFixed(2).replace('.',',')}" placeholder="0,00" inputmode="decimal" data-op-id="${op.id}">
                <button class="cda-opcao-del" data-op-id="${op.id}" data-add-id="${g.id}" title="Remover">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
                </button>
              </div>`).join('')}
          </div>
          <button class="cda-btn-add-opcao" data-add-id="${g.id}">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4.5" y1="1" x2="4.5" y2="8"/><line x1="1" y1="4.5" x2="8" y2="4.5"/></svg>
            Adicionar opção
          </button>
        </div>
      </div>`).join('');
  }

  function bindAdicionaisBodyEvents(drawer) {
    const body = drawer.querySelector('#cda-body');
    if (!body) return;

    body.addEventListener('click', e => {
      // ── Menu de 3 pontinhos (verificado ANTES do toggle) ──────────────────
      const menuBtn = e.target.closest('.cda-group-menu');
      if (menuBtn) {
        e.stopPropagation();
        _showAdicionaisGroupMenu(menuBtn, parseInt(menuBtn.dataset.addId), drawer);
        return;
      }

      // ── Delete opção ───────────────────────────────────────────────────────
      const delOp = e.target.closest('.cda-opcao-del');
      if (delOp) {
        const opId  = parseInt(delOp.dataset.opId);
        const addId = parseInt(delOp.dataset.addId);
        _deleteAdicionalOpcao(addId, opId, drawer);
        return;
      }

      // ── Adicionar opção ────────────────────────────────────────────────────
      const addOpBtn = e.target.closest('.cda-btn-add-opcao');
      if (addOpBtn) {
        _addAdicionalOpcao(parseInt(addOpBtn.dataset.addId), drawer);
        return;
      }

      // ── Toggle expandir/recolher grupo ─────────────────────────────────────
      // Qualquer clique no header (exceto botões já tratados acima) expande/recolhe.
      // Exceção: se o grupo já está aberto e o clique foi em input/select,
      // deixa passar para que o campo possa receber foco (edição).
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const group  = toggle.closest('.cda-group');
        const isOpen = group?.classList.contains('open');
        if (isOpen && e.target.closest('input, select')) return; // permite edição
        group?.classList.toggle('open');
        console.log('[CDA] toggle grupo', group?.dataset.addId, group?.classList.contains('open') ? 'aberto' : 'fechado');
      }
    });

    // Field changes (blur = save)
    body.addEventListener('blur', async e => {
      const nome = e.target.closest('.cda-group-nome');
      if (nome) { await _saveAdicionalField(parseInt(nome.dataset.addId), {}, drawer); return; }
      const sel = e.target.closest('.cda-select[data-field]');
      if (sel)  { await _saveAdicionalField(parseInt(sel.dataset.addId), {}, drawer); return; }
      const num = e.target.closest('.cda-num-input[data-field]');
      if (num)  { await _saveAdicionalField(parseInt(num.dataset.addId), {}, drawer); return; }
    }, true);

    body.addEventListener('change', async e => {
      const cb = e.target.closest('input[type="checkbox"][data-field="obrigatorio"]');
      if (cb) { await _saveAdicionalField(parseInt(cb.dataset.addId), {}, drawer); }
    });
  }

  async function _saveAdicionalField(addId, extra, drawer) {
    const group = drawer.querySelector(`.cda-group[data-add-id="${addId}"]`);
    if (!group) return;
    const nome        = group.querySelector(`.cda-group-nome[data-add-id="${addId}"]`)?.value?.trim() || '';
    const tipo        = group.querySelector(`.cda-select[data-field="tipo"]`)?.value || 'multiplo';
    const max_escolhas = parseInt(group.querySelector(`.cda-num-input[data-field="max_escolhas"]`)?.value) || 1;
    const obrigatorio = group.querySelector(`input[data-field="obrigatorio"]`)?.checked ? 1 : 0;
    if (!nome) return;
    try {
      await json('PATCH', `/api/cardapio/adicionais/${addId}`, {nome, tipo, max_escolhas, obrigatorio, min_escolhas: 0, opcoes: _getOpcoesList(group, addId)});
      // Update badges
      const badges = group.querySelector('.cda-group-badges');
      if (badges) {
        badges.innerHTML = `
          ${obrigatorio ? '<span class="cda-badge obrig">OBRIG</span>' : '<span class="cda-badge">OPC</span>'}
          <span class="cda-badge">${tipo === 'unico' ? '1' : `≤${max_escolhas}`}</span>`;
      }
    } catch(e) { console.warn('[cda] save error:', e.message); }
  }

  function _getOpcoesList(group, addId) {
    return [...group.querySelectorAll(`.cda-opcao-row`)].map(row => ({
      id: parseInt(row.dataset.opId) || undefined,
      nome: row.querySelector('.cda-opcao-nome')?.value?.trim() || '',
      preco: parsePreco(row.querySelector('.cda-opcao-preco')?.value || '0'),
    })).filter(o => o.nome);
  }

  async function _addAdicionalOpcao(addId, drawer) {
    const group  = drawer.querySelector(`.cda-group[data-add-id="${addId}"]`);
    const list   = group?.querySelector(`.cda-opcoes-list[data-opcoes-for="${addId}"]`);
    if (!list) return;
    // Save with new empty option to get the ID
    const opcoes = _getOpcoesList(group, addId);
    opcoes.push({nome: 'Nova opção', preco: 0});
    try {
      await json('PATCH', `/api/cardapio/adicionais/${addId}`, {
        nome: group.querySelector(`.cda-group-nome[data-add-id="${addId}"]`)?.value?.trim() || '',
        tipo: group.querySelector('.cda-select[data-field="tipo"]')?.value || 'multiplo',
        max_escolhas: parseInt(group.querySelector('.cda-num-input[data-field="max_escolhas"]')?.value) || 1,
        obrigatorio: group.querySelector(`input[data-field="obrigatorio"]`)?.checked ? 1 : 0,
        min_escolhas: 0,
        opcoes,
      });
      // Reload this group's options from API
      const fresh = await api('/api/cardapio/adicionais');
      const g = fresh.find(x => x.id === addId);
      if (g && g.opcoes.length) {
        const lastOp = g.opcoes[g.opcoes.length - 1];
        const row = document.createElement('div');
        row.className = 'cda-opcao-row';
        row.dataset.opId = lastOp.id;
        row.innerHTML = `
          <input class="cda-opcao-nome" value="${esc(lastOp.nome)}" data-op-id="${lastOp.id}">
          <input class="cda-opcao-preco" value="${(lastOp.preco||0).toFixed(2).replace('.',',')}" inputmode="decimal" data-op-id="${lastOp.id}">
          <button class="cda-opcao-del" data-op-id="${lastOp.id}" data-add-id="${addId}" title="Remover">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
          </button>`;
        list.appendChild(row);
        row.querySelector('.cda-opcao-nome').focus();
        row.querySelector('.cda-opcao-nome').select();
      }
    } catch(e) { window.Toast?.error('Erro: ' + e.message); }
  }

  async function _deleteAdicionalOpcao(addId, opId, drawer) {
    const group  = drawer.querySelector(`.cda-group[data-add-id="${addId}"]`);
    if (!group) return;
    const opcoes = _getOpcoesList(group, addId).filter(o => o.id !== opId);
    try {
      await json('PATCH', `/api/cardapio/adicionais/${addId}`, {
        nome: group.querySelector(`.cda-group-nome[data-add-id="${addId}"]`)?.value?.trim() || '',
        tipo: group.querySelector('.cda-select[data-field="tipo"]')?.value || 'multiplo',
        max_escolhas: parseInt(group.querySelector('.cda-num-input[data-field="max_escolhas"]')?.value) || 1,
        obrigatorio: group.querySelector(`input[data-field="obrigatorio"]`)?.checked ? 1 : 0,
        min_escolhas: 0,
        opcoes,
      });
      const row = group.querySelector(`.cda-opcao-row[data-op-id="${opId}"]`);
      row?.remove();
    } catch(e) { window.Toast?.error('Erro: ' + e.message); }
  }

  let _adicionaisMenuEl   = null;
  let _adicionaisMenuAddId = null;
  function _showAdicionaisGroupMenu(btn, addId, drawer) {
    _adicionaisMenuEl?.remove();
    _adicionaisMenuAddId = addId;
    const menu = document.createElement('div');
    menu.id = 'cda-group-menu-dd';
    menu.style.cssText = `position:fixed;z-index:600;background:#111;border:1px solid #222;border-radius:4px;min-width:160px;padding:4px 0;`;
    menu.innerHTML = `
      <button style="display:block;width:100%;padding:8px 14px;background:none;border:none;color:#ef4444;font-family:Inter,sans-serif;font-size:12px;text-align:left;cursor:pointer" data-menu-act="delete">Excluir grupo</button>`;
    const rect = btn.getBoundingClientRect();
    menu.style.top  = rect.bottom + 4 + 'px';
    menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
    document.body.appendChild(menu);
    _adicionaisMenuEl = menu;

    menu.querySelector('[data-menu-act="delete"]').onclick = async () => {
      menu.remove(); _adicionaisMenuEl = null;
      const ok = await window.Dialog?.confirm({
        title: 'Excluir grupo',
        message: 'Todos os produtos que usam este grupo de adicionais serão desvinculados. Continuar?',
        confirmText: 'Excluir', danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/cardapio/adicionais/${addId}`, {method:'DELETE'});
        drawer.querySelector(`.cda-group[data-add-id="${addId}"]`)?.remove();
        _adicionaisGrupos = _adicionaisGrupos.filter(g => g.id !== addId);
        if (!drawer.querySelectorAll('.cda-group').length) {
          drawer.querySelector('#cda-body').innerHTML = renderAdicionaisGrupos([]);
        }
        window.Toast?.success('Grupo excluído');
      } catch(e) { window.Toast?.error('Erro: ' + e.message); }
    };

    const closeMenu = e => {
      if (!menu.contains(e.target)) { menu.remove(); _adicionaisMenuEl = null; document.removeEventListener('click', closeMenu, true); }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  }

  function closeAdicionaisDrawer() {
    const drawer   = document.getElementById('cda-drawer');
    const backdrop = document.getElementById('cda-backdrop');
    _adicionaisMenuEl?.remove(); _adicionaisMenuEl = null;
    if (drawer) {
      drawer.classList.remove('open');
      setTimeout(() => drawer.remove(), 260);
    }
    if (backdrop) backdrop.classList.remove('open');
  }

  /* ──── Template ──────────────────────────────────────────────────────────── */
  const TEMPLATE = `
    <div class="cd-topbar">
      <span class="cd-title">Cardápio</span>
      <div class="cd-search">
        <svg class="cd-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.5"/><line x1="9.5" y1="9.5" x2="13" y2="13"/></svg>
        <input type="text" class="cd-search-input" placeholder="Buscar produtos, categorias...">
        <span class="cd-kbd">⌘K</span>
      </div>
      <button class="cd-btn-sync-vitrine" id="cd-btn-sync-vitrine" title="Sincronizar cardápio com a Vitrine Digital">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6A5 5 0 1 0 3.2 2.2"/><path d="M1 1v3h3"/></svg>
        Sincronizar vitrine
      </button>
    </div>
    <div class="cd-body">
      <div class="cd-col-cat">
        <div class="cd-col-header">Categorias</div>
        <div class="cd-import-btn-wrap">
          <button class="cd-btn-import-ai" id="cd-btn-import-ai">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#00d0b7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 1l1.2 2.6L11 4.6l-2 1.9.5 2.8L7 8l-2.5 1.3.5-2.8L3 4.6l2.8-.8z"/>
              <line x1="11" y1="9" x2="13" y2="11"/><line x1="11" y1="11" x2="13" y2="9"/>
            </svg>
            Importar com IA
          </button>
        </div>
        <div id="cd-cat-list" class="cd-cat-list"></div>
        <div class="cd-new-cat-wrap">
          <button class="cd-btn-nova-cat" id="cd-btn-nova-cat">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>
            Nova categoria
          </button>
        </div>
        <div class="cd-adicionais-btn-wrap">
          <button class="cd-btn-adicionais" id="cd-btn-adicionais">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 1l.9 2L10 3.4 8 5.3l.5 2.8L6.5 7l-2 1.1L5 5.3 3 3.4l2.6-.4z"/><line x1="10" y1="9" x2="12" y2="11"/><line x1="10" y1="11" x2="12" y2="9"/></svg>
            Adicionais e Complementos
          </button>
        </div>
      </div>
      <div class="cd-col-prod">
        <div class="cd-prod-header">
          <div class="cd-prod-header-text">
            <h2 id="cd-prod-h-title">Selecione uma categoria</h2>
            <p id="cd-prod-h-sub">Crie sua primeira categoria para começar</p>
          </div>
          <button class="cd-btn-novo-item" id="cd-btn-novo-item" disabled style="opacity:0.3;cursor:not-allowed">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>
            Novo item
          </button>
        </div>
        <div class="cd-prod-area" id="cd-prod-area"></div>
      </div>
      <div class="cd-col-prev">
        <div class="cd-col-header">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:5px"><rect x="1.5" y="0.5" width="8" height="10" rx="1"/><line x1="4" y1="9" x2="7" y2="9"/></svg>
          Preview Mobile
        </div>
        <div class="cd-prev-controls">
          <button class="cd-prev-refresh-btn" id="cd-prev-refresh-btn" title="Atualizar preview">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6A5 5 0 1 0 3.2 2.2"/><path d="M1 1v3h3"/></svg>
            Atualizar
          </button>
        </div>
        <div class="cd-prev-center">
          <div class="cd-phone-outer">
            <div class="cd-phone-notch"></div>
            <div class="cd-phone-screen" id="cd-phone-screen">
              <div class="cd-prev-overlay" id="cd-prev-overlay">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2" stroke-linecap="round"><path d="M10 2a8 8 0 1 0 8 8" style="animation:cd-spin 0.8s linear infinite;transform-origin:10px 10px"/></svg>
              </div>
              <iframe id="cd-preview-iframe" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" frameborder="0" style="display:none;border:0;flex-shrink:0"></iframe>
              <div class="cd-prev-state" id="cd-prev-state" style="display:none"></div>
            </div>
          </div>
        </div>
        <div class="cd-prev-footer">
          <span class="cd-prev-last-sync" id="cd-prev-last-sync">—</span>
          <a href="#" class="cd-fullscreen-link" id="cd-btn-fullscreen">Abrir em tela cheia ↗</a>
        </div>
      </div>
    </div>
  `;

  /* ──── Sync vitrine ─────────────────────────────────────────────────────── */
  async function syncVitrine() {
    const btn = document.getElementById('cd-btn-sync-vitrine');
    if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando...'; }
    try {
      const r    = await fetch(apiBase() + '/api/vitrine/sync', { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        const st  = data.stats || {};
        const msg = st.produtos !== undefined
          ? `Vitrine sincronizada: ${st.categorias} cat, ${st.produtos} produtos${st.promocoes > 0 ? `, ${st.promocoes} promoção(ões)` : ''}`
          : 'Vitrine sincronizada';
        window.Toast?.success(msg);
      } else {
        window.Toast?.error(data.error || 'Falha no sync');
      }
    } catch (ex) {
      window.Toast?.error('Erro de conexão: ' + ex.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Sincronizar vitrine'; }
    }
  }

  /* ──── Preview mobile ───────────────────────────────────────────────────── */
  function goToConfig() {
    document.querySelector('a[data-page="config"]')?.click();
  }

  async function initPreview() {
    // URL da vitrine: mesma fonte que o agente WhatsApp usa (cardapio_url ou vitrine_url
    // de /api/settings). NÃO usa /api/vitrine/info — o campo url_publica vem bugado do Hub.
    let vitrineUrl = null;
    try {
      const cfg = await api('/api/settings');
      const raw = cfg.cardapio_url || cfg.vitrine_url || null;
      vitrineUrl = (raw && /^https?:\/\//i.test(raw)) ? raw : null;
    } catch (_) {}

    _previewVitrineUrl = vitrineUrl;

    if (vitrineUrl) {
      loadPreviewIframe(vitrineUrl);
    } else {
      // Sem URL configurada — esconde o preview em vez de mostrar erro
      const phone  = document.getElementById('cd-phone-screen');
      const footer = document.querySelector('.cd-prev-footer');
      if (phone)  phone.style.visibility = 'hidden';
      if (footer) footer.style.visibility = 'hidden';
    }

    document.getElementById('cd-prev-refresh-btn')?.addEventListener('click', () => {
      if (_previewVitrineUrl) reloadPreviewIframe();
    });
    document.getElementById('cd-btn-fullscreen')?.addEventListener('click', e => {
      e.preventDefault(); openFullscreenPreview();
    });

    startSyncTimeUpdater();
    startPreviewSSE();
  }

  // Indicadores de status removidos — funções mantidas como no-op para não quebrar
  // chamadas remanescentes em loadPreviewIframe (onload/onerror).
  function _setPreviewStatus(_status) {}
  function updatePill(_status) {}

  function showPreviewState(motivo) {
    const iframe  = document.getElementById('cd-preview-iframe');
    const overlay = document.getElementById('cd-prev-overlay');
    const state   = document.getElementById('cd-prev-state');
    if (iframe)  iframe.style.display  = 'none';
    if (overlay) overlay.style.display = 'none';
    if (!state) return;
    state.style.display = 'flex';

    const cfg = {
      sem_token: {
        icon: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="12" width="20" height="14" rx="2"/><path d="M9 12V8a5 5 0 0 1 10 0v4"/><line x1="14" y1="18" x2="14" y2="20"/></svg>`,
        title: 'Vitrine não configurada', sub: 'Adicione o token da vitrine em Configurações',
        btn: 'Ir para Configurações', act: 'config',
      },
      token_invalido: {
        icon: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="14" cy="14" r="12"/><line x1="14" y1="9" x2="14" y2="15"/><circle cx="14" cy="19" r="1" fill="currentColor" stroke="none"/></svg>`,
        title: 'Token inválido', sub: 'Reconecte sua vitrine em Configurações',
        btn: 'Ir para Configurações', act: 'config',
      },
      wp_offline: {
        icon: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2l24 24M12.5 6.5A14 14 0 0 1 26 14c-1.5 2-3.5 3.8-5.8 5M6.3 10A14 14 0 0 0 2 14c2.5 4 7 7 12 7a13.5 13.5 0 0 0 6-1.4M14 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`,
        title: 'Servidor inacessível', sub: 'Não foi possível conectar ao servidor Ceia',
        btn: 'Tentar de novo', act: 'retry',
      },
      sem_cardapio: {
        icon: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="14" cy="17" r="9"/><path d="M7 17a7 7 0 0 1 14 0M14 8V4M10 5l1.5 2.5M18 5l-1.5 2.5"/></svg>`,
        title: 'Aguardando sincronização', sub: 'Edite o cardápio para gerar a vitrine',
        btn: null, act: null,
      },
    };
    const m = cfg[motivo] || cfg.wp_offline;
    state.innerHTML = `
      <div class="cd-prev-state-inner">
        ${m.icon}
        <strong>${m.title}</strong>
        <span>${m.sub}</span>
        ${m.btn ? `<button class="cd-prev-state-btn" data-act="${m.act}">${m.btn}</button>` : ''}
      </div>`;
    state.querySelector('[data-act="config"]')?.addEventListener('click', goToConfig);
    state.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      if (_previewVitrineUrl) {
        state.style.display = 'none';
        loadPreviewIframe(_previewVitrineUrl);
      }
    });
  }

  function loadPreviewIframe(url) {
    // Log para diagnóstico — confirma o valor exato que chega no iframe.src
    console.log('[Preview] loadPreviewIframe url:', url);

    // Guard: rejeita URLs relativas/sem-esquema que resolveriam para file://
    if (!url || !/^https?:\/\//i.test(url)) {
      console.warn('[Preview] URL inválida ou relativa descartada (não é https://):', url);
      const state = document.getElementById('cd-prev-state');
      if (state) { state.style.display = 'flex'; }
      showPreviewState('wp_offline');
      _setPreviewStatus('erro');
      return;
    }

    const iframe  = document.getElementById('cd-preview-iframe');
    const overlay = document.getElementById('cd-prev-overlay');
    const state   = document.getElementById('cd-prev-state');
    if (!iframe) return;

    // Mostra spinner, esconde erro anterior
    if (overlay) { overlay.style.opacity = '1'; overlay.style.display = 'flex'; }
    if (state)   state.style.display = 'none';
    _previewWaiting = false;

    // Aplica viewport mobile (375px) + scale para encaixar na moldura ANTES de setar src,
    // assim a vitrine renderiza em layout mobile desde o carregamento inicial.
    _applyMobileScale(iframe);

    iframe.onerror = () => {
      iframe.style.display = 'none';
      if (overlay) overlay.style.display = 'none';
      _setPreviewStatus('erro');
      showPreviewState('wp_offline');
      schedulePreviewRetry(url);
    };
    iframe.onload = () => {
      if (!overlay) return;
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.style.display = 'none'; overlay.style.opacity = '1'; }, 200);
      _setPreviewStatus('ok');
    };
    iframe.src = url;
  }

  // Renderiza o iframe em 375px de largura (viewport mobile) e escala visualmente
  // para caber na moldura do preview sem cortar conteúdo nem gerar scroll horizontal.
  function _applyMobileScale(iframe) {
    const screen = document.getElementById('cd-phone-screen');
    if (!screen || !iframe) return;
    const W = screen.offsetWidth;
    const H = screen.offsetHeight;
    if (!W || !H) return;
    const MOBILE_W = 375;
    const scale = W / MOBILE_W;
    iframe.style.width           = MOBILE_W + 'px';
    iframe.style.height          = Math.ceil(H / scale) + 'px';
    iframe.style.transform       = `scale(${scale})`;
    iframe.style.transformOrigin = 'top left';
    iframe.style.display         = 'block';
  }
  // compatibilidade: renderPreviewState chamava checkUrlAndLoadIframe
  function checkUrlAndLoadIframe(url) { loadPreviewIframe(url); }

  function schedulePreviewRetry(url) {
    clearTimeout(_previewWaitTimer);
    _previewWaiting = true;
    _previewWaitTimer = setTimeout(() => {
      if (!_previewWaiting) return;
      _previewWaiting = false;
      loadPreviewIframe(url);
    }, 30_000);
  }

  function reloadPreviewIframe() {
    const iframe  = document.getElementById('cd-preview-iframe');
    const overlay = document.getElementById('cd-prev-overlay');
    if (!iframe || iframe.style.display === 'none') {
      if (_previewVitrineUrl) loadPreviewIframe(_previewVitrineUrl);
      return;
    }
    _applyMobileScale(iframe); // garante scale correto após reload
    if (overlay) { overlay.style.opacity = '1'; overlay.style.display = 'flex'; }
    iframe.onload = () => {
      if (!overlay) return;
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.style.display = 'none'; overlay.style.opacity = '1'; }, 200);
    };
    try { iframe.contentWindow.location.reload(); }
    catch(_) { iframe.src = iframe.src; }
  }

  function startPreviewSSE() {
    stopPreviewSSE();
    try {
      _previewSSE = new EventSource(apiBase() + '/api/eventos');
      _previewSSE.onmessage = e => {
        try {
          const data = JSON.parse(e.data);
          if (data.tipo !== 'vitrine_atualizada') return;
          // Resolve any pending esgotado sync watchers
          Object.keys(_vitrineConfirmCbs).forEach(k => {
            const cb = _vitrineConfirmCbs[k];
            delete _vitrineConfirmCbs[k];
            try { cb(); } catch(_) {}
          });
          _lastSyncAt = Date.now();
          updateSyncTimeEl();
          clearTimeout(_previewReload);
          _previewReload = setTimeout(() => reloadPreviewIframe(), 600);
        } catch(_) {}
      };
      _previewSSE.onerror = () => {
        if (_previewSSE && _previewSSE.readyState === EventSource.CLOSED) {
          stopPreviewSSE();
          setTimeout(startPreviewSSE, 3000);
        }
      };
    } catch(e) {
      console.warn('[Preview] SSE não suportado:', e.message);
    }
  }

  function stopPreviewSSE() {
    if (_previewSSE) { _previewSSE.close(); _previewSSE = null; }
    clearTimeout(_previewReload);
    clearTimeout(_previewWaitTimer);
    _previewWaiting = false;
  }

  function startSyncTimeUpdater() {
    clearInterval(_syncTimeTimer);
    updateSyncTimeEl();
    _syncTimeTimer = setInterval(updateSyncTimeEl, 30_000);
  }

  function updateSyncTimeEl() {
    const el = document.getElementById('cd-prev-last-sync');
    if (!el) return;
    if (!_lastSyncAt) { el.textContent = '—'; return; }
    const s = Math.floor((Date.now() - _lastSyncAt) / 1000);
    if (s < 60) el.textContent = `Última sync: há ${s}s`;
    else if (s < 3600) el.textContent = `Última sync: há ${Math.floor(s / 60)}min`;
    else el.textContent = `Última sync: há ${Math.floor(s / 3600)}h`;
  }

  function openFullscreenPreview() {
    if (!_previewVitrineUrl) return;
    if (document.getElementById('cd-prev-fullscreen')) return;
    const url = _previewVitrineUrl;
    const modal = document.createElement('div');
    modal.id = 'cd-prev-fullscreen';
    modal.innerHTML = `
      <div class="cd-fs-backdrop"></div>
      <div class="cd-fs-inner">
        <button class="cd-fs-close" id="cd-fs-close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </button>
        <div class="cd-fs-phone">
          <div class="cd-fs-notch"></div>
          <div class="cd-fs-screen">
            <div class="cd-fs-overlay" id="cd-fs-overlay">
              <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2" stroke-linecap="round"><path d="M10 2a8 8 0 1 0 8 8" style="animation:cd-spin 0.8s linear infinite;transform-origin:10px 10px"/></svg>
            </div>
            <iframe src="${esc(url)}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" frameborder="0" style="width:100%;height:100%;border:0;display:block"></iframe>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('open'));
    modal.querySelector('.cd-fs-backdrop').onclick = closeFullscreenPreview;
    modal.querySelector('#cd-fs-close').onclick    = closeFullscreenPreview;
    modal.querySelector('iframe').onload = () => {
      const ov = document.getElementById('cd-fs-overlay');
      if (ov) { ov.style.opacity = '0'; setTimeout(() => ov.remove(), 200); }
    };
    const onEsc = e => { if (e.key === 'Escape') closeFullscreenPreview(); };
    document.addEventListener('keydown', onEsc);
    modal._onEsc = onEsc;
  }

  function closeFullscreenPreview() {
    const modal = document.getElementById('cd-prev-fullscreen');
    if (!modal) return;
    if (modal._onEsc) document.removeEventListener('keydown', modal._onEsc);
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 220);
  }

  /* ──── mount / unmount ───────────────────────────────────────────────────── */
  async function mount(container) {
    container.style.display = 'flex';
    document.getElementById('content')?.classList.add('cd-active');
    container.innerHTML = TEMPLATE;
    document.getElementById('cd-btn-nova-cat').onclick   = startNewCat;
    document.getElementById('cd-btn-import-ai').onclick  = openImportModal;
    document.getElementById('cd-btn-novo-item').onclick  = addNewProduto;
    document.getElementById('cd-btn-adicionais').onclick  = openAdicionaisDrawer;
    document.getElementById('cd-btn-sync-vitrine').onclick = syncVitrine;
    document.removeEventListener('keydown', onKeyDown); // garante no máximo 1 listener
    document.addEventListener('keydown', onKeyDown);
    // Inicia cardápio e preview em paralelo
    await Promise.all([
      loadCategorias().catch(e => console.error('[Cardapio] load error:', e)),
      initPreview(),
    ]);
    // Polling de reconciliação: rebusca estado a cada 15s enquanto a aba está ativa.
    // Cinto de segurança — corrige estado mesmo que um evento SSE seja perdido.
    _reconcileTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadCategorias().catch(() => {});
        if (state.selectedId) loadProdutos(state.selectedId).catch(() => {});
      }
    }, 15_000);
  }

  function unmount(container) {
    if (container) container.style.display = 'none';
    document.getElementById('content')?.classList.remove('cd-active');
    closeCatDropdown();
    closeProdDropdown();
    document.querySelector('.cd-cat-drawer')?.remove();
    _drawerCatId = null;
    closeProdDrawer();
    closeAdicionaisDrawer();
    document.getElementById('cd-import-modal')?.remove();
    document.getElementById('cd-prev-fullscreen')?.remove();
    stopPreviewSSE();
    clearInterval(_syncTimeTimer);
    _syncTimeTimer = null;
    clearInterval(_reconcileTimer);
    _reconcileTimer = null;
    document.removeEventListener('keydown', onKeyDown);
  }

  function init() {}

  // Expose helpers needed by inline onclick in templates
  return { init, mount, unmount, _addNewProduto: addNewProduto, _openImportModal: openImportModal, _openAdicionais: openAdicionaisDrawer };
})();
