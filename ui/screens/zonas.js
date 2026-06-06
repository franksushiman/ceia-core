/**
 * Zonas de Entrega — Fase 6
 * Google Maps + desenho manual (Polygon/Circle nativos) + CRUD de zonas geográficas.
 * DrawingManager foi descontinuado pelo Google — substituído por engine própria.
 */
const Zonas = (() => {
  function apiBase() { return window.CEIA?.apiBase || 'http://127.0.0.1:3000'; }

  function api(path, opts = {}) {
    return fetch(apiBase() + path, opts).then(r => {
      if (!r.ok) return r.json().then(d => { throw new Error(d.error || r.statusText); });
      return r.json();
    });
  }
  function json(method, path, body) {
    return api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── State ────────────────────────────────────────────────────────────────────
  let _container      = null;
  let _zonas          = [];
  let _map            = null;
  let _overlays       = {};     // id → { overlay, tipo }
  let _selectedId     = null;
  let _mapKey         = null;
  let _activeMode     = null;   // 'polygon' | 'circle' | null (= move)
  let _pendingOverlay = null;   // overlay just drawn, not yet saved
  let _pendingGeo     = null;   // { tipo, geometria }
  let _redesenhando   = false;
  let _redesenhandoId = null;
  let _dragSrcIdx     = null;
  let _drawerZonaId   = null;
  let _drawState      = null;   // active drawing session (polygon or circle)

  const COLORS = ['#00d0b7','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#10b981','#f97316','#ec4899'];

  const DARK_STYLES = [
    { elementType: 'geometry',           stylers: [{ color: '#1a1a1a' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0a0a' }] },
    { elementType: 'labels.text.fill',   stylers: [{ color: '#6b6b6b' }] },
    { featureType: 'road',    elementType: 'geometry', stylers: [{ color: '#2a2a2a' }] },
    { featureType: 'water',   elementType: 'geometry', stylers: [{ color: '#0f1419' }] },
    { featureType: 'poi',     stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ];

  // ── Template ─────────────────────────────────────────────────────────────────
  const TEMPLATE = `
    <div class="zonas-wrap">
      <div class="zonas-topbar">
        <div class="zonas-topbar-left">
          <span class="zonas-topbar-title">Zonas de Entrega</span>
          <div class="zonas-maps-pill warn" id="zonas-maps-pill" title="Configurar chave Google Maps">
            <span class="zonas-maps-pill-dot"></span>
            <span id="zonas-maps-pill-txt">Verificando...</span>
          </div>
        </div>
        <button class="zonas-btn-nova" id="zonas-btn-nova">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/>
          </svg>
          Nova zona
        </button>
      </div>
      <div class="zonas-body">
        <div class="zonas-sidebar">
          <div class="zonas-sidebar-hdr">Zonas cadastradas</div>
          <div class="zonas-list" id="zonas-list"></div>
        </div>
        <div class="zonas-map-area" id="zonas-map-area">
          <div class="zonas-draw-tools" id="zonas-draw-tools" style="display:none">
            <button class="ztool-btn active" data-mode="move" id="ztool-move">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M6.5 1v11M1 6.5h11"/>
                <polyline points="4.5,3.5 6.5,1 8.5,3.5"/>
                <polyline points="4.5,9.5 6.5,12 8.5,9.5"/>
                <polyline points="3.5,4.5 1,6.5 3.5,8.5"/>
                <polyline points="9.5,4.5 12,6.5 9.5,8.5"/>
              </svg>
              Mover
            </button>
            <button class="ztool-btn" data-mode="polygon" id="ztool-polygon">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="6.5,1 12,5 10,12 3,12 1,5"/>
              </svg>
              Polígono
            </button>
            <button class="ztool-btn" data-mode="circle" id="ztool-circle">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="6.5" cy="6.5" r="5.5"/>
              </svg>
              Círculo
            </button>
          </div>
          <div id="zonas-map" style="width:100%;height:100%"></div>
          <div class="zonas-map-empty" id="zonas-map-empty" style="display:none">
            <svg class="zonas-map-empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M24 44C24 44 8 32 8 20a16 16 0 0 1 32 0c0 12-16 24-16 24z"/>
              <circle cx="24" cy="20" r="5"/>
            </svg>
            <div class="zonas-map-empty-title">Chave Google Maps não configurada</div>
            <div class="zonas-map-empty-sub">Configure sua chave de API do Google Maps nas Configurações para usar o mapa interativo.</div>
            <button class="zonas-map-empty-btn" id="zonas-goto-cfg">Ir para Configurações</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // ── Mount / Unmount ──────────────────────────────────────────────────────────
  function mount(container) {
    _container = container;

    // Remove padding from parent .content so map fills height
    const content = container.parentElement;
    if (content) {
      content._z_pad = content.style.padding;
      content._z_ovf = content.style.overflow;
      content._z_dsp = content.style.display;
      content._z_fld = content.style.flexDirection;
      content.style.padding = '0';
      content.style.overflow = 'hidden';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
    }

    container.style.cssText = 'display:flex;flex-direction:column;flex:1;height:100%;min-height:0;';
    container.classList.add('active');
    container.innerHTML = TEMPLATE;

    document.getElementById('zonas-btn-nova').onclick = onNova;
    document.getElementById('zonas-goto-cfg')?.addEventListener('click', gotoConfig);
    document.getElementById('zonas-maps-pill').onclick = gotoConfig;

    loadZonas();
  }

  function unmount(container) {
    const content = container?.parentElement;
    if (content && content._z_pad !== undefined) {
      content.style.padding       = content._z_pad;
      content.style.overflow      = content._z_ovf;
      content.style.display       = content._z_dsp;
      content.style.flexDirection = content._z_fld;
    }

    // Clean up Maps
    _clearDrawState();
    for (const { overlay } of Object.values(_overlays)) { try { overlay.setMap(null); } catch (_) {} }
    _overlays = {}; _map = null;
    _pendingOverlay = null; _pendingGeo = null;
    _activeMode = null; _selectedId = null;
    _redesenhando = false; _redesenhandoId = null;
    _drawerZonaId = null;

    if (container) {
      container.classList.remove('active');
      container.style.cssText = 'display:none;';
    }
  }

  function gotoConfig() {
    document.querySelector('nav a[data-page="config"]')?.click();
  }

  // ── Data ─────────────────────────────────────────────────────────────────────
  async function loadZonas() {
    try { _zonas = await api('/api/zonas'); } catch (_) { _zonas = []; }
    renderList();
    await initMapIfNeeded();
  }

  // ── List ─────────────────────────────────────────────────────────────────────
  function renderList() {
    const list = document.getElementById('zonas-list');
    if (!list) return;

    if (_zonas.length === 0) {
      list.innerHTML = `<div class="zonas-list-empty">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="color:var(--border-hover)">
          <path d="M14 26C14 26 4 19 4 12a10 10 0 0 1 20 0c0 7-10 14-10 14z"/>
          <circle cx="14" cy="12" r="3"/>
        </svg>
        <span>Nenhuma zona cadastrada</span>
        <span style="color:var(--text-dim);font-size:11px">Desenhe a primeira no mapa</span>
      </div>`;
      return;
    }

    list.innerHTML = _zonas.map((z, idx) => `
      <div class="zona-card ${z.id === _selectedId ? 'selected' : ''}"
           data-id="${z.id}" data-idx="${idx}" draggable="true">
        <div class="zona-card-r1">
          <span class="zona-handle" title="Reordenar">
            <svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="2" cy="2"  r=".5" fill="currentColor" stroke="none"/>
              <circle cx="6" cy="2"  r=".5" fill="currentColor" stroke="none"/>
              <circle cx="2" cy="6"  r=".5" fill="currentColor" stroke="none"/>
              <circle cx="6" cy="6"  r=".5" fill="currentColor" stroke="none"/>
              <circle cx="2" cy="10" r=".5" fill="currentColor" stroke="none"/>
              <circle cx="6" cy="10" r=".5" fill="currentColor" stroke="none"/>
            </svg>
          </span>
          <span class="zona-dot" style="background:${esc(z.cor||'#00d0b7')}"></span>
          <span class="zona-nome" data-did="${z.id}">${esc(z.nome)}</span>
          <span class="zona-taxa">R$ ${(z.taxa||0).toFixed(2).replace('.',',')}</span>
          <button class="zona-menu-btn" data-mid="${z.id}" title="Opções">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6.5" cy="2.5" r=".7" fill="currentColor" stroke="none"/>
              <circle cx="6.5" cy="6.5" r=".7" fill="currentColor" stroke="none"/>
              <circle cx="6.5" cy="10.5" r=".7" fill="currentColor" stroke="none"/>
            </svg>
          </button>
        </div>
        <div class="zona-card-r2">
          <span class="zona-meta">${z.tempo_min||30}–${z.tempo_max||60} min · ${z.tipo === 'circulo' ? 'Círculo' : 'Polígono'}</span>
          ${!z.ativa ? '<span class="zona-inativa-tag">Inativa</span>' : ''}
        </div>
      </div>`).join('');

    bindListEvents(list);
  }

  function bindListEvents(list) {
    list.addEventListener('click', e => {
      const menuBtn = e.target.closest('[data-mid]');
      if (menuBtn) { e.stopPropagation(); showMenu(menuBtn, parseInt(menuBtn.dataset.mid)); return; }
      const card = e.target.closest('.zona-card');
      if (card) selectZona(parseInt(card.dataset.id));
    });

    list.addEventListener('dblclick', e => {
      const nameEl = e.target.closest('[data-did]');
      if (nameEl) { e.stopPropagation(); inlineEdit(parseInt(nameEl.dataset.did), nameEl); }
    });

    // Drag-to-reorder
    list.addEventListener('dragstart', e => {
      const card = e.target.closest('.zona-card'); if (!card) return;
      _dragSrcIdx = parseInt(card.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const card = e.target.closest('.zona-card');
      list.querySelectorAll('.zona-card').forEach(c => c.classList.remove('drag-over'));
      if (card && parseInt(card.dataset.idx) !== _dragSrcIdx) card.classList.add('drag-over');
    });
    list.addEventListener('drop', async e => {
      e.preventDefault();
      const card = e.target.closest('.zona-card');
      list.querySelectorAll('.zona-card').forEach(c => c.classList.remove('drag-over', 'dragging'));
      if (!card || _dragSrcIdx === null) return;
      const destIdx = parseInt(card.dataset.idx);
      if (destIdx === _dragSrcIdx) { _dragSrcIdx = null; return; }
      const moved = _zonas.splice(_dragSrcIdx, 1)[0];
      _zonas.splice(destIdx, 0, moved);
      renderList();
      try { await json('POST', '/api/zonas/reorder', { ids: _zonas.map(z => z.id) }); } catch (_) {}
      _dragSrcIdx = null;
    });
    list.addEventListener('dragend', () => {
      list.querySelectorAll('.zona-card').forEach(c => c.classList.remove('dragging', 'drag-over'));
      _dragSrcIdx = null;
    });
  }

  function selectZona(id) {
    _selectedId = id; renderList(); fitZona(id);
  }

  function fitZona(id) {
    const entry = _overlays[id];
    if (!entry || !_map || !window.google?.maps) return;
    try {
      if (entry.tipo === 'poligono') {
        const bounds = new google.maps.LatLngBounds();
        entry.overlay.getPath().forEach(pt => bounds.extend(pt));
        _map.fitBounds(bounds, { top: 60, bottom: 40, left: 40, right: 40 });
      } else {
        _map.fitBounds(entry.overlay.getBounds(), { top: 60, bottom: 40, left: 40, right: 40 });
      }
    } catch (_) {}
  }

  // ── Inline edit ──────────────────────────────────────────────────────────────
  function inlineEdit(id, el) {
    const zona = _zonas.find(z => z.id === id); if (!zona) return;
    const input = document.createElement('input');
    input.className = 'zona-nome-input'; input.value = zona.nome;
    el.replaceWith(input); input.focus(); input.select();
    const commit = async () => {
      const nome = input.value.trim();
      if (nome && nome !== zona.nome) {
        try { await json('PATCH', `/api/zonas/${id}`, { nome }); zona.nome = nome; } catch (_) {}
      }
      renderList();
    };
    input.onblur = commit;
    input.onkeydown = e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.onblur = null; renderList(); }
    };
  }

  // ── Context menu ─────────────────────────────────────────────────────────────
  function showMenu(btn, id) {
    document.querySelectorAll('.zona-dropdown').forEach(d => d.remove());
    const zona = _zonas.find(z => z.id === id); if (!zona) return;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'zona-dropdown';
    menu.style.top  = (rect.bottom + 4) + 'px';
    menu.style.left = Math.min(rect.left, window.innerWidth - 175) + 'px';
    menu.innerHTML = `
      <button class="zona-dropdown-item" data-a="editar">Editar</button>
      <button class="zona-dropdown-item" data-a="duplicar">Duplicar</button>
      <button class="zona-dropdown-item" data-a="toggle">${zona.ativa ? 'Desativar' : 'Ativar'}</button>
      <button class="zona-dropdown-item danger" data-a="excluir">Excluir</button>
    `;
    document.body.appendChild(menu);
    menu.addEventListener('click', async e => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      menu.remove();
      const a = b.dataset.a;
      if (a === 'editar')   openDrawer(id);
      if (a === 'duplicar') await duplicar(id);
      if (a === 'toggle')   await toggleAtiva(id);
      if (a === 'excluir')  await excluir(id);
    });
    const close = e => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close, true); }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }

  async function toggleAtiva(id) {
    const z = _zonas.find(z => z.id === id); if (!z) return;
    try {
      await json('PATCH', `/api/zonas/${id}`, { ativa: z.ativa ? 0 : 1 });
      z.ativa = z.ativa ? 0 : 1; renderList(); updateOverlayStyle(id);
    } catch (e) { window.Toast?.error('Erro: ' + e.message); }
  }

  async function duplicar(id) {
    const z = _zonas.find(z => z.id === id); if (!z) return;
    try {
      const r = await json('POST', '/api/zonas', {
        nome: z.nome + ' (cópia)', tipo: z.tipo, geometria: z.geometria,
        taxa: z.taxa, tempo_min: z.tempo_min, tempo_max: z.tempo_max, cor: z.cor, ativa: 1,
      });
      _zonas.push(r.zona); renderList();
      if (_map) addOverlay(r.zona);
      window.Toast?.success('Zona duplicada');
    } catch (e) { window.Toast?.error('Erro: ' + e.message); }
  }

  async function excluir(id) {
    const z = _zonas.find(z => z.id === id); if (!z) return;
    const ok = await window.Dialog?.confirm({
      title: 'Excluir zona',
      message: `Tem certeza que deseja excluir "${z.nome}"? Esta ação não pode ser desfeita.`,
      confirmText: 'Excluir', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/zonas/${id}`, { method: 'DELETE' });
      removeOverlay(id);
      _zonas = _zonas.filter(z => z.id !== id);
      if (_selectedId === id) _selectedId = null;
      renderList();
      window.Toast?.success('Zona excluída');
    } catch (e) { window.Toast?.error('Erro: ' + e.message); }
  }

  // ── Map init — usa CeiaGMaps loader compartilhado ───────────────────────────
  async function initMapIfNeeded() {
    const pill    = document.getElementById('zonas-maps-pill');
    const pillTxt = document.getElementById('zonas-maps-pill-txt');

    try {
      await window.CeiaGMaps.load();
      _mapKey = window.CeiaGMaps.getKey() || '';
    } catch (e) {
      _mapKey = '';
      if (pill) pill.className = 'zonas-maps-pill warn';
      if (pillTxt) pillTxt.textContent = e.message?.includes('configurada') ? 'Chave não configurada' : 'Chave inválida';
      showMapEmpty();
      return;
    }

    if (pill) pill.className = 'zonas-maps-pill ok';
    if (pillTxt) pillTxt.textContent = 'Google Maps';
    const tools = document.getElementById('zonas-draw-tools');
    if (tools) tools.style.display = '';

    await ceiaMapInit();
  }

  function showMapEmpty() {
    const mapEl   = document.getElementById('zonas-map');
    const emptyEl = document.getElementById('zonas-map-empty');
    if (mapEl) mapEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    document.getElementById('zonas-goto-cfg')?.addEventListener('click', gotoConfig);
  }

  async function ceiaMapInit() {
    const mapEl = document.getElementById('zonas-map');
    if (!mapEl || !window.google?.maps) return;

    // Fetch store coords BEFORE creating the map so the initial center is correct.
    // Fallback: Florianópolis (SC) — sensible default for the region instead of Brasília.
    let initCenter = { lat: -27.5954, lng: -48.5480 };
    try {
      const d = await api('/api/settings/loja_coords');
      if (d.lat && d.lng) initCenter = { lat: parseFloat(d.lat), lng: parseFloat(d.lng) };
    } catch (_) {}

    _map = new google.maps.Map(mapEl, {
      center: initCenter,
      zoom: 13,
      styles: DARK_STYLES,
      disableDefaultUI: true,
      zoomControl: true,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      gestureHandling: 'greedy',
    });

    for (const z of _zonas) addOverlay(z);

    // fitBounds must wait for the map to finish its first layout — calling it on a
    // freshly-constructed Map before the container is sized silently does nothing.
    if (_zonas.length) {
      google.maps.event.addListenerOnce(_map, 'idle', fitAllZonas);
    }

    document.querySelectorAll('.ztool-btn').forEach(btn => {
      btn.onclick = () => {
        const m = btn.dataset.mode;
        setMode(m === 'move' || m === _activeMode ? null : m);
      };
    });
  }

  function fitAllZonas() {
    if (!_map || !_zonas.length || !window.google?.maps) return;
    try {
      const bounds = new google.maps.LatLngBounds();
      let extended = false;
      for (const z of _zonas) {
        try {
          const geo = typeof z.geometria === 'string' ? JSON.parse(z.geometria) : z.geometria;
          if (z.tipo === 'poligono' && Array.isArray(geo)) {
            for (const p of geo) bounds.extend({ lat: p.lat, lng: p.lng });
            extended = true;
          } else if (z.tipo === 'circulo' && geo?.center) {
            const R = 6371000;
            const lat = geo.center.lat, lng = geo.center.lng, r = geo.radius;
            const dLat = (r / R) * (180 / Math.PI);
            const dLng = dLat / Math.cos(lat * Math.PI / 180);
            bounds.extend({ lat: lat - dLat, lng: lng - dLng });
            bounds.extend({ lat: lat + dLat, lng: lng + dLng });
            extended = true;
          }
        } catch (_) {}
      }
      if (extended) _map.fitBounds(bounds, 40);
    } catch (_) {}
  }

  // ── Drawing engine (replaces deprecated DrawingManager) ─────────────────────

  /** Haversine distance in metres between two lat/lng points. */
  function _haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function _clearDrawState() {
    if (!_drawState) return;
    const s = _drawState; _drawState = null;
    s.listeners?.forEach(l => { try { google.maps.event.removeListener(l); } catch(_){} });
    if (s.previewPolyline)  { try { s.previewPolyline.setMap(null);  } catch(_){} }
    if (s.tailLine)         { try { s.tailLine.setMap(null);          } catch(_){} }
    if (s.previewCircle)    { try { s.previewCircle.setMap(null);     } catch(_){} }
    if (s.centerDot)        { try { s.centerDot.setMap(null);         } catch(_){} }
    s.pointMarkers?.forEach(m => { try { m.setMap(null); } catch(_){} });
    if (s.keyHandler) document.removeEventListener('keydown', s.keyHandler);
    if (_map) _map.setOptions({ draggableCursor: null, disableDoubleClickZoom: false });
  }

  function _completeDrawing(tipo, geometria, overlay) {
    _clearDrawState();
    _activeMode = null;
    document.querySelectorAll('.ztool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === 'move');
    });
    _pendingOverlay = overlay;
    _pendingGeo = { tipo, geometria };
    if (_redesenhando && _redesenhandoId) { finalizarRedesenho(); return; }
    openDrawer(null, `Zona ${_zonas.length + 1}`, tipo);
  }

  function _startPolygonDraw() {
    const s = { mode: 'polygon', points: [], listeners: [], pointMarkers: [],
                previewPolyline: null, tailLine: null, keyHandler: null };
    _drawState = s;
    _map.setOptions({ draggableCursor: 'crosshair', disableDoubleClickZoom: true });

    s.previewPolyline = new google.maps.Polyline({
      path: [], strokeColor: '#00d0b7', strokeOpacity: 0.85, strokeWeight: 2, map: _map,
    });
    s.tailLine = new google.maps.Polyline({
      path: [], strokeColor: '#00d0b7', strokeOpacity: 0.5, strokeWeight: 1.5, map: _map,
    });

    s.keyHandler = e => { if (e.key === 'Escape') setMode(null); };
    document.addEventListener('keydown', s.keyHandler);

    s.listeners.push(
      _map.addListener('click', ev => {
        if (!_drawState || _drawState !== s) return;
        const pt = { lat: ev.latLng.lat(), lng: ev.latLng.lng() };
        s.points.push(pt);
        // Close the preview path back to first point
        s.previewPolyline.setPath(s.points.length > 1 ? [...s.points, s.points[0]] : s.points);
        // Small dot at each vertex
        const dot = new google.maps.Circle({
          center: pt, radius: 5,
          fillColor: '#00d0b7', fillOpacity: 1,
          strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 1,
          clickable: false, zIndex: 10, map: _map,
        });
        s.pointMarkers.push(dot);
      }),

      _map.addListener('dblclick', () => {
        if (!_drawState || _drawState !== s) return;
        // dblclick fires two preceding clicks — remove last duplicate point
        if (s.points.length > 0) {
          s.points.pop();
          const m = s.pointMarkers.pop(); try { m?.setMap(null); } catch(_){}
        }
        if (s.points.length < 3) {
          window.Toast?.error('Desenhe pelo menos 3 pontos para criar um polígono');
          return;
        }
        const geometria = [...s.points];
        const overlay = new google.maps.Polygon({
          paths: geometria,
          fillColor: '#00d0b7', fillOpacity: 0.3,
          strokeColor: '#00d0b7', strokeOpacity: 0.85, strokeWeight: 2, map: _map,
        });
        _completeDrawing('poligono', geometria, overlay);
      }),

      _map.addListener('mousemove', ev => {
        if (!_drawState || _drawState !== s || s.points.length === 0) return;
        s.tailLine.setPath([s.points[s.points.length - 1],
                            { lat: ev.latLng.lat(), lng: ev.latLng.lng() }]);
      }),
    );
  }

  function _startCircleDraw() {
    const s = { mode: 'circle', step: 'center', center: null, listeners: [],
                previewCircle: null, centerDot: null, keyHandler: null };
    _drawState = s;
    _map.setOptions({ draggableCursor: 'crosshair', disableDoubleClickZoom: true });

    s.centerDot = new google.maps.Circle({
      radius: 8, fillColor: '#00d0b7', fillOpacity: 1,
      strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 1.5,
      clickable: false, zIndex: 10, map: null,
    });
    s.previewCircle = new google.maps.Circle({
      radius: 1, fillColor: '#00d0b7', fillOpacity: 0.2,
      strokeColor: '#00d0b7', strokeOpacity: 0.7, strokeWeight: 1.5,
      clickable: false, map: null,
    });

    s.keyHandler = e => { if (e.key === 'Escape') setMode(null); };
    document.addEventListener('keydown', s.keyHandler);

    s.listeners.push(
      _map.addListener('click', ev => {
        if (!_drawState || _drawState !== s) return;
        const pt = { lat: ev.latLng.lat(), lng: ev.latLng.lng() };

        if (s.step === 'center') {
          s.center = pt; s.step = 'radius';
          s.centerDot.setCenter(pt); s.centerDot.setMap(_map);
          s.previewCircle.setCenter(pt); s.previewCircle.setRadius(1); s.previewCircle.setMap(_map);
          window.Toast?.info('Clique no mapa para definir o raio');
        } else {
          const radius = _haversineM(s.center.lat, s.center.lng, pt.lat, pt.lng);
          if (radius < 50) { window.Toast?.error('Raio mínimo: 50 metros'); return; }
          const geometria = { center: s.center, radius };
          const overlay = new google.maps.Circle({
            center: s.center, radius,
            fillColor: '#00d0b7', fillOpacity: 0.3,
            strokeColor: '#00d0b7', strokeOpacity: 0.85, strokeWeight: 2, map: _map,
          });
          _completeDrawing('circulo', geometria, overlay);
        }
      }),

      _map.addListener('mousemove', ev => {
        if (!_drawState || _drawState !== s || s.step !== 'radius' || !s.center) return;
        const r = _haversineM(s.center.lat, s.center.lng,
                              ev.latLng.lat(), ev.latLng.lng());
        s.previewCircle.setRadius(Math.max(r, 50));
      }),
    );
  }

  function setMode(mode) {
    _activeMode = mode;
    document.querySelectorAll('.ztool-btn').forEach(btn => {
      btn.classList.toggle('active', mode ? btn.dataset.mode === mode : btn.dataset.mode === 'move');
    });
    _clearDrawState();
    if (!_map || !window.google?.maps) return;
    if (mode === 'polygon') _startPolygonDraw();
    else if (mode === 'circle') _startCircleDraw();
  }

  // ── Overlays ─────────────────────────────────────────────────────────────────
  function addOverlay(zona) {
    if (!_map || !window.google?.maps) return;
    const cor = zona.cor || '#00d0b7';
    const op  = zona.ativa ? 1 : 0.4;
    let overlay;
    try {
      const geo = typeof zona.geometria === 'string' ? JSON.parse(zona.geometria) : zona.geometria;
      if (zona.tipo === 'poligono') {
        overlay = new google.maps.Polygon({
          paths: geo.map(p => ({ lat: p.lat, lng: p.lng })),
          fillColor: cor, fillOpacity: 0.3 * op,
          strokeColor: cor, strokeOpacity: 0.85 * op, strokeWeight: 2, map: _map,
        });
      } else {
        overlay = new google.maps.Circle({
          center: { lat: geo.center.lat, lng: geo.center.lng }, radius: geo.radius,
          fillColor: cor, fillOpacity: 0.3 * op,
          strokeColor: cor, strokeOpacity: 0.85 * op, strokeWeight: 2, map: _map,
        });
      }
      overlay.addListener('click', () => selectZona(zona.id));
      _overlays[zona.id] = { overlay, tipo: zona.tipo };
    } catch (e) { console.error('[Zonas] addOverlay falhou:', e, zona); }
  }

  function removeOverlay(id) {
    const e = _overlays[id];
    if (e) { try { e.overlay.setMap(null); } catch (_) {} delete _overlays[id]; }
  }

  function updateOverlayStyle(id) {
    const z = _zonas.find(z => z.id === id); const e = _overlays[id];
    if (!z || !e) return;
    const cor = z.cor || '#00d0b7'; const op = z.ativa ? 1 : 0.4;
    try { e.overlay.setOptions({ fillColor: cor, fillOpacity: 0.3 * op, strokeColor: cor, strokeOpacity: 0.85 * op }); }
    catch (_) {}
  }

  // ── Drawer ───────────────────────────────────────────────────────────────────
  function openDrawer(id, suggestedName, suggestedTipo) {
    closeDrawer(); _drawerZonaId = id;
    const z     = id ? _zonas.find(z => z.id === id) : null;
    const nome  = z?.nome  || suggestedName || '';
    const taxa  = z?.taxa  ?? 0;
    const tMin  = z?.tempo_min ?? 30;
    const tMax  = z?.tempo_max ?? 60;
    const cor   = z?.cor   || '#00d0b7';
    const ativa = z?.ativa ?? 1;
    const tipo  = z?.tipo  || suggestedTipo || 'poligono';

    let geo = {};
    try { geo = z ? (typeof z.geometria === 'string' ? JSON.parse(z.geometria) : z.geometria) : (_pendingGeo?.geometria || {}); }
    catch (_) {}

    const geoInfo = tipo === 'poligono'
      ? `Polígono · ${Array.isArray(geo) ? geo.length : '?'} pontos`
      : `Círculo · raio ${geo.radius ? (geo.radius/1000).toFixed(1)+' km' : '—'}`;

    const swatches = COLORS.map(c =>
      `<span class="zd-swatch ${c === cor ? 'sel' : ''}" data-c="${c}" style="background:${c}"></span>`
    ).join('');

    const drawer = document.createElement('div');
    drawer.className = 'zona-drawer'; drawer.id = 'zona-drawer';
    drawer.innerHTML = `
      <div class="zona-drawer-hdr">
        <span class="zona-drawer-title">${id ? 'Editar zona' : 'Nova zona'}</span>
        <button class="zona-drawer-close" id="zd-close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </button>
      </div>
      <div class="zona-drawer-body">
        <div class="zd-field">
          <label class="zd-label">Nome</label>
          <input class="zd-input" id="zd-nome" value="${esc(nome)}" maxlength="60" placeholder="Ex: Centro">
        </div>
        <div class="zd-field">
          <label class="zd-label">Taxa de entrega (R$)</label>
          <input class="zd-input" id="zd-taxa" value="${taxa.toFixed(2).replace('.',',')}" inputmode="decimal" placeholder="0,00" style="max-width:120px">
        </div>
        <div class="zd-field">
          <label class="zd-label">Tempo estimado (min)</label>
          <div class="zd-row2">
            <div class="zd-field"><input class="zd-input" id="zd-tmin" value="${tMin}" inputmode="numeric"></div>
            <span class="zd-sep">a</span>
            <div class="zd-field"><input class="zd-input" id="zd-tmax" value="${tMax}" inputmode="numeric"></div>
          </div>
        </div>
        <div class="zd-field">
          <label class="zd-label">Cor da zona</label>
          <div class="zd-palette" id="zd-palette">${swatches}</div>
          <input type="hidden" id="zd-cor" value="${esc(cor)}">
        </div>
        <div class="zd-field">
          <label class="zd-label">Status</label>
          <div class="zd-status-row">
            <label class="zd-status-opt ${ativa ? 'is-ativa' : ''}" id="zd-lbl-ativa">
              <input type="radio" name="zdAtiva" value="1" ${ativa ? 'checked' : ''}>
              <span class="zd-dot-sm" style="background:#4ade80"></span>Ativa
            </label>
            <label class="zd-status-opt ${!ativa ? 'is-inativa' : ''}" id="zd-lbl-inativa">
              <input type="radio" name="zdAtiva" value="0" ${!ativa ? 'checked' : ''}>
              <span class="zd-dot-sm" style="background:var(--text-dim)"></span>Inativa
            </label>
          </div>
        </div>
        <hr class="zd-sep-line">
        <div class="zd-geo-info" id="zd-geo-info">
          <strong style="color:var(--text-muted)">Geometria</strong><br>${geoInfo}
        </div>
        <button class="zd-btn-redesenhar" id="zd-redesenhar">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M1 6a5 5 0 1 0 5-5 5 5 0 0 0-3.5 1.5"/>
            <polyline points="1 1 1 4 4 4"/>
          </svg>
          Redesenhar geometria
        </button>
      </div>
      <div class="zona-drawer-footer">
        ${id ? `<button class="zd-btn-delete" id="zd-del">Excluir</button>` : '<span></span>'}
        <button class="zd-btn-save" id="zd-save">Salvar</button>
      </div>
    `;
    document.body.appendChild(drawer);

    let bd = document.getElementById('zona-backdrop');
    if (!bd) {
      bd = document.createElement('div'); bd.className = 'zona-backdrop'; bd.id = 'zona-backdrop';
      document.body.appendChild(bd);
    }
    bd.classList.add('open');
    bd.onclick = () => cancelDrawer(id);
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      setTimeout(() => drawer.querySelector('#zd-nome')?.focus(), 60);
    });

    // Enter = salvar (exceto em textarea); Esc = cancelar
    drawer.addEventListener('keydown', e => {
      if (e.key === 'Escape') { cancelDrawer(id); return; }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        drawer.querySelector('#zd-save')?.click();
      }
    });

    drawer.querySelector('#zd-close').onclick = () => cancelDrawer(id);

    drawer.querySelector('#zd-palette').addEventListener('click', e => {
      const sw = e.target.closest('.zd-swatch'); if (!sw) return;
      drawer.querySelectorAll('.zd-swatch').forEach(s => s.classList.remove('sel'));
      sw.classList.add('sel');
      drawer.querySelector('#zd-cor').value = sw.dataset.c;
      if (_pendingOverlay) {
        try { _pendingOverlay.setOptions({ fillColor: sw.dataset.c, strokeColor: sw.dataset.c }); } catch (_) {}
      }
    });

    drawer.querySelectorAll('[name="zdAtiva"]').forEach(r => {
      r.onchange = () => {
        drawer.querySelector('#zd-lbl-ativa').className   = `zd-status-opt ${r.value === '1' ? 'is-ativa' : ''}`;
        drawer.querySelector('#zd-lbl-inativa').className = `zd-status-opt ${r.value === '0' ? 'is-inativa' : ''}`;
      };
    });

    drawer.querySelector('#zd-redesenhar').onclick = () => {
      _redesenhando = true; _redesenhandoId = id;
      drawer.style.right = '-400px';
      bd.classList.remove('open');
      setMode(tipo === 'circulo' ? 'circle' : 'polygon');
    };

    drawer.querySelector('#zd-del')?.addEventListener('click', async () => {
      closeDrawer(); await excluir(id);
    });

    drawer.querySelector('#zd-save').onclick = () => saveDrawer(drawer, id, tipo);
  }

  function cancelDrawer(id) {
    if (!id && _pendingOverlay) {
      try { _pendingOverlay.setMap(null); } catch (_) {}
      _pendingOverlay = null; _pendingGeo = null;
    }
    closeDrawer();
  }

  function closeDrawer() {
    _drawerZonaId = null; _redesenhando = false; _redesenhandoId = null;
    const dr = document.getElementById('zona-drawer');
    const bd = document.getElementById('zona-backdrop');
    if (dr) { dr.classList.remove('open'); setTimeout(() => dr.remove(), 260); }
    if (bd) bd.classList.remove('open');
  }

  function finalizarRedesenho() {
    _redesenhando = false;
    const dr = document.getElementById('zona-drawer');
    const bd = document.getElementById('zona-backdrop');
    if (dr) { dr.style.right = '0'; dr.classList.add('open'); }
    if (bd) bd.classList.add('open');

    if (dr && _pendingGeo) {
      const { tipo, geometria } = _pendingGeo;
      const info = tipo === 'poligono'
        ? `Polígono · ${Array.isArray(geometria) ? geometria.length : '?'} pontos`
        : `Círculo · raio ${geometria.radius ? (geometria.radius/1000).toFixed(1)+' km' : '—'}`;
      const el = dr.querySelector('#zd-geo-info');
      if (el) el.innerHTML = `<strong style="color:var(--text-muted)">Geometria</strong><br>${info}`;
    }
    if (_redesenhandoId) removeOverlay(_redesenhandoId);
  }

  async function saveDrawer(drawer, id, tipo) {
    const saveBtn = drawer.querySelector('#zd-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Salvando...';

    const nome = drawer.querySelector('#zd-nome').value.trim();
    if (!nome) {
      window.Toast?.error('Informe o nome da zona');
      saveBtn.disabled = false; saveBtn.textContent = 'Salvar'; return;
    }
    const taxa      = parseFloat((drawer.querySelector('#zd-taxa').value || '0').replace(',', '.')) || 0;
    const tempo_min = parseInt(drawer.querySelector('#zd-tmin').value) || 30;
    const tempo_max = parseInt(drawer.querySelector('#zd-tmax').value) || 60;
    const cor       = drawer.querySelector('#zd-cor').value || '#00d0b7';
    const ativa     = parseInt(drawer.querySelector('[name="zdAtiva"]:checked')?.value ?? '1');

    try {
      if (id) {
        const patch = { nome, taxa, tempo_min, tempo_max, cor, ativa };
        if (_pendingGeo) { patch.tipo = _pendingGeo.tipo; patch.geometria = JSON.stringify(_pendingGeo.geometria); }
        await json('PATCH', `/api/zonas/${id}`, patch);
        const z = _zonas.find(z => z.id === id);
        if (z) {
          Object.assign(z, { nome, taxa, tempo_min, tempo_max, cor, ativa });
          if (_pendingGeo) { z.tipo = _pendingGeo.tipo; z.geometria = JSON.stringify(_pendingGeo.geometria); }
        }
        removeOverlay(id);
        const zz = _zonas.find(z => z.id === id); if (zz) addOverlay(zz);
      } else {
        if (!_pendingGeo) throw new Error('Nenhuma geometria desenhada');
        const r = await json('POST', '/api/zonas', {
          nome, taxa, tempo_min, tempo_max, cor, ativa,
          tipo: _pendingGeo.tipo, geometria: JSON.stringify(_pendingGeo.geometria),
        });
        _zonas.push(r.zona);
        if (_pendingOverlay) { try { _pendingOverlay.setMap(null); } catch (_) {} _pendingOverlay = null; }
        addOverlay(r.zona);
      }
      _pendingOverlay = null; _pendingGeo = null;
      renderList(); closeDrawer();
      window.Toast?.success(id ? 'Zona atualizada' : 'Zona criada');
    } catch (e) {
      window.Toast?.error('Erro: ' + e.message);
      saveBtn.disabled = false; saveBtn.textContent = 'Salvar';
    }
  }

  // ── Nova zona (topbar) ───────────────────────────────────────────────────────
  function onNova() {
    if (!_mapKey) { window.Toast?.error('Configure a chave Google Maps em Configurações'); return; }
    if (!_map) { window.Toast?.error('Aguardando mapa carregar...'); return; }
    setMode('polygon');
    window.Toast?.info('Clique no mapa para adicionar pontos. Duplo clique para fechar o polígono. Esc cancela.');
  }

  return { mount, unmount };
})();
