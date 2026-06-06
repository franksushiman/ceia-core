/**
 * CEIA OS — Relatórios & Analytics
 * Gráficos acionáveis: cada um apoia uma decisão de operação, cardápio ou margem.
 */
/* global window, document, Chart */

const Relatorios = (() => {
  'use strict';

  let _el      = null;
  let _periodo = '30';
  let _charts  = []; // Chart instances para destruir no unmount

  function _api(path) {
    return ((window.CEIA && window.CEIA.apiBase) || 'http://127.0.0.1:3000') + path;
  }

  function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function _fmtBRL(v) {
    return (Number(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  }

  function _fmtPct(v) {
    return (Number(v)||0).toFixed(1) + '%';
  }

  function _destroyCharts() {
    _charts.forEach(c => { try { c.destroy(); } catch(_){} });
    _charts = [];
  }

  // ── Chart.js global defaults ──────────────────────────────────────────────────
  function _configureChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color          = '#94a3b8';
    Chart.defaults.borderColor    = 'rgba(255,255,255,0.08)';
    Chart.defaults.font.family    = 'Inter, system-ui, sans-serif';
    Chart.defaults.font.size      = 11;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.tooltip.backgroundColor = '#1e293b';
    Chart.defaults.plugins.tooltip.borderColor      = 'rgba(255,255,255,0.1)';
    Chart.defaults.plugins.tooltip.borderWidth      = 1;
    Chart.defaults.plugins.tooltip.titleColor       = '#e2e8f0';
    Chart.defaults.plugins.tooltip.bodyColor        = '#94a3b8';
    Chart.defaults.plugins.tooltip.padding          = 10;
  }

  // ── Carrega Chart.js se não estiver disponível ────────────────────────────────
  function _loadChartJS() {
    if (window.Chart) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
      s.onload  = () => { _configureChartDefaults(); resolve(); };
      s.onerror = () => reject(new Error('Falha ao carregar Chart.js'));
      document.head.appendChild(s);
    });
  }

  // ── Utilitário: monta novo Chart e o registra ─────────────────────────────────
  function _makeChart(canvasId, config) {
    const canvas = _el && _el.querySelector('#' + canvasId);
    if (!canvas) return null;
    const c = new Chart(canvas, config);
    _charts.push(c);
    return c;
  }

  // ── Seção: título + subtitle ──────────────────────────────────────────────────
  function _secao(id, titulo, subtitulo) {
    return `
      <section class="rel-section" id="sec-${id}">
        <div class="rel-section-header">
          <h2 class="rel-section-title">${_esc(titulo)}</h2>
          <p class="rel-section-sub">${_esc(subtitulo)}</p>
        </div>
        <div class="rel-section-body" id="body-${id}">
          <div class="rel-loading">Carregando...</div>
        </div>
      </section>`;
  }

  // ── Período selecionado ───────────────────────────────────────────────────────
  function _params() {
    return '?dias=' + _periodo;
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 2.1 — Heatmap hora×dia
  // ════════════════════════════════════════════════════════════════════════════════
  async function _heatmap() {
    const body = _el.querySelector('#body-heatmap');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/heatmap' + _params()));
      const rows = await r.json();

      if (!rows.length) { body.innerHTML = '<div class="rel-empty">Sem dados no período.</div>'; return; }

      // Build 7×24 matrix
      const matrix = Array.from({length:7}, () => new Array(24).fill(0));
      let maxVal = 0;
      for (const row of rows) {
        matrix[row.dia][row.hora] = row.pedidos;
        if (row.pedidos > maxVal) maxVal = row.pedidos;
      }

      const DIAS  = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

      const cellSize = 32;
      const labelW   = 36;

      let html = '<div class="rel-heatmap-wrap">';

      // Header com horas (a cada 2h)
      html += '<div class="rel-heatmap-grid" style="grid-template-columns:' + labelW + 'px repeat(24,' + cellSize + 'px)">';
      html += '<div></div>'; // corner
      for (let h = 0; h < 24; h++) {
        html += '<div class="rel-hm-hlabel">' + (h % 2 === 0 ? h + 'h' : '') + '</div>';
      }

      // Rows
      for (let d = 0; d < 7; d++) {
        html += '<div class="rel-hm-dlabel">' + DIAS[d] + '</div>';
        for (let h = 0; h < 24; h++) {
          const v   = matrix[d][h];
          const pct = maxVal > 0 ? v / maxVal : 0;
          const bg  = pct === 0
            ? 'rgba(255,255,255,0.03)'
            : 'rgba(0,208,183,' + (0.12 + pct * 0.88).toFixed(2) + ')';
          const clr = pct > 0.6 ? '#000' : 'var(--text-muted)';
          html += '<div class="rel-hm-cell" style="background:' + bg + ';color:' + clr + '"' +
                  ' title="' + DIAS[d] + ' ' + h + ':00 — ' + v + ' pedido' + (v!==1?'s':'') + '">' + (v || '') + '</div>';
        }
      }
      html += '</div>'; // grid

      // Legenda
      html += '<div class="rel-hm-legend">' +
        '<span style="font-size:10px;color:var(--text-dim)">Frio (sem pedidos)</span>' +
        '<div style="display:flex;gap:2px;align-items:center">' +
        [0.05,0.2,0.4,0.65,0.88,1].map(p =>
          '<div style="width:18px;height:14px;border-radius:3px;background:rgba(0,208,183,' + (0.12+p*0.88).toFixed(2) + ')"></div>'
        ).join('') +
        '</div>' +
        '<span style="font-size:10px;color:var(--text-dim)">Quente (pico)</span>' +
        '</div>';

      html += '</div>'; // wrap
      body.innerHTML = html;
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 1.2 — Curva ABC
  // ════════════════════════════════════════════════════════════════════════════════
  async function _abc() {
    const body = _el.querySelector('#body-abc');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/abc' + _params()));
      const data = await r.json();
      const items = data.items || [];

      if (!items.length) { body.innerHTML = '<div class="rel-empty">Sem vendas no período.</div>'; return; }

      const labels   = items.map(i => i.nome.length > 20 ? i.nome.slice(0,20)+'…' : i.nome);
      const receitas = items.map(i => i.receita);
      const acums    = items.map(i => i.pct_acum);

      const bgColors = items.map(i =>
        i.pct_acum <= 80  ? 'rgba(0,208,183,0.75)'
        : i.pct_acum <= 95 ? 'rgba(234,179,8,0.75)'
        : 'rgba(239,68,68,0.75)'
      );

      body.innerHTML = '<div style="position:relative;height:340px"><canvas id="chart-abc"></canvas></div>' +
        '<div class="rel-legend-row">' +
        '<span class="rel-badge" style="background:rgba(0,208,183,.25);color:var(--teal)">A — Top 80% receita</span>' +
        '<span class="rel-badge" style="background:rgba(234,179,8,.25);color:#eab308">B — 80–95%</span>' +
        '<span class="rel-badge" style="background:rgba(239,68,68,.25);color:#ef4444">C — Cauda</span>' +
        '</div>';

      _makeChart('chart-abc', {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { type: 'bar',  label: 'Receita (R$)', data: receitas, backgroundColor: bgColors,
              yAxisID: 'y', borderRadius: 3 },
            { type: 'line', label: '% Acumulado', data: acums, borderColor: '#f8fafc',
              borderWidth: 1.5, pointRadius: 2, fill: false, tension: 0.2, yAxisID: 'y2' },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: 'top' },
            tooltip: { callbacks: {
              label: ctx => ctx.dataset.yAxisID === 'y2'
                ? _fmtPct(ctx.raw)
                : _fmtBRL(ctx.raw)
            }}
          },
          scales: {
            x: { ticks: { maxRotation: 45, font: { size: 10 } } },
            y: { position: 'left',  ticks: { callback: v => _fmtBRL(v) } },
            y2: { position: 'right', min: 0, max: 100,
                  ticks: { callback: v => v + '%' },
                  grid: { drawOnChartArea: false } }
          }
        }
      });
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 1.4 — Encalhe
  // ════════════════════════════════════════════════════════════════════════════════
  async function _encalhe() {
    const body = _el.querySelector('#body-encalhe');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/encalhe' + _params()));
      const rows = await r.json();

      if (!rows.length) { body.innerHTML = '<div class="rel-empty">Sem produtos cadastrados.</div>'; return; }

      const linhas = rows.map(p => {
        const dias = p.dias_sem_venda;
        const cor  = dias === null ? '#ef4444'
                   : dias > 30    ? '#ef4444'
                   : dias > 14    ? '#f59e0b'
                   : 'var(--text-muted)';
        const diaTxt = dias === null ? 'Nunca vendido' : dias + 'd atrás';
        return '<tr>' +
          '<td style="font-weight:500;color:var(--text)">' + _esc(p.nome) + '</td>' +
          '<td style="color:var(--text-muted)">' + _esc(p.categoria || '—') + '</td>' +
          '<td style="color:var(--teal);white-space:nowrap">' + _fmtBRL(p.preco) + '</td>' +
          '<td style="color:' + cor + ';white-space:nowrap">' + _esc(diaTxt) + '</td>' +
          '<td style="color:var(--text-muted);text-align:right">' + (p.unidades || 0) + '</td>' +
          '</tr>';
      }).join('');

      body.innerHTML = '<div class="rel-table-wrap">' +
        '<table class="rel-table">' +
        '<thead><tr>' +
        '<th>Produto</th><th>Categoria</th><th>Preço</th>' +
        '<th>Última venda</th><th style="text-align:right">Unid.</th>' +
        '</tr></thead>' +
        '<tbody>' + linhas + '</tbody>' +
        '</table>' +
        '</div>';
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 2.3 — Rentabilidade por Zona
  // ════════════════════════════════════════════════════════════════════════════════
  async function _zonas() {
    const body = _el.querySelector('#body-zonas');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/zonas' + _params()));
      const rows = await r.json();

      if (!rows.length) { body.innerHTML = '<div class="rel-empty">Sem dados por zona no período.</div>'; return; }

      const maxTicket = Math.max(...rows.map(r => r.ticket_medio));
      const bgColors  = rows.map(r => {
        const intensity = maxTicket > 0 ? r.ticket_medio / maxTicket : 0.3;
        return 'rgba(0,208,183,' + (0.2 + intensity * 0.65).toFixed(2) + ')';
      });

      const tableRows = rows.map(z =>
        '<tr>' +
        '<td style="color:var(--text);font-weight:500">' + _esc(z.bairro) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + z.pedidos + '</td>' +
        '<td style="text-align:right;color:var(--teal)">' + _fmtBRL(z.receita) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + _fmtBRL(z.ticket_medio) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + _fmtBRL(z.taxa_media) + '</td>' +
        '</tr>'
      ).join('');

      body.innerHTML =
        '<div style="position:relative;height:' + Math.min(rows.length*36+60,320) + 'px;margin-bottom:16px">' +
        '<canvas id="chart-zonas"></canvas>' +
        '</div>' +
        '<div class="rel-table-wrap">' +
        '<table class="rel-table">' +
        '<thead><tr><th>Bairro/Zona</th><th style="text-align:right">Pedidos</th>' +
        '<th style="text-align:right">Receita</th><th style="text-align:right">Ticket médio</th>' +
        '<th style="text-align:right">Taxa média</th></tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '</table>' +
        '</div>';

      _makeChart('chart-zonas', {
        type: 'bar',
        data: {
          labels: rows.map(r => r.bairro),
          datasets: [{
            label: 'Receita (R$)',
            data:  rows.map(r => r.receita),
            backgroundColor: bgColors,
            borderRadius: 4,
            indexAxis: 'y',
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => _fmtBRL(ctx.raw) } }
          },
          scales: {
            x: { ticks: { callback: v => _fmtBRL(v) } },
            y: { ticks: { font: { size: 11 } } }
          }
        }
      });
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 3.4 — Custo por Meio de Pagamento
  // ════════════════════════════════════════════════════════════════════════════════
  async function _pagamentos() {
    const body = _el.querySelector('#body-pagamentos');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/pagamentos' + _params()));
      const rows = await r.json();

      if (!rows.length) { body.innerHTML = '<div class="rel-empty">Sem dados no período.</div>'; return; }

      const total = rows.reduce((s,r) => s + r.receita, 0);
      const CORES = ['rgba(0,208,183,0.8)','rgba(234,179,8,0.8)','rgba(99,102,241,0.8)',
                     'rgba(239,68,68,0.8)','rgba(34,197,94,0.8)'];

      const tableRows = rows.map((p,i) =>
        '<tr>' +
        '<td style="display:flex;align-items:center;gap:8px">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + CORES[i%CORES.length] + ';flex-shrink:0"></span>' +
        '<span style="color:var(--text);font-weight:500">' + _esc(p.forma) + '</span>' +
        '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + p.pedidos + '</td>' +
        '<td style="text-align:right;color:var(--teal)">' + _fmtBRL(p.receita) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + _fmtBRL(p.ticket_medio) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + _fmtPct(total > 0 ? p.receita/total*100 : 0) + '</td>' +
        '</tr>'
      ).join('');

      body.innerHTML =
        '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">' +
        '<div style="width:220px;height:220px;flex-shrink:0;position:relative">' +
        '<canvas id="chart-pagamentos"></canvas>' +
        '</div>' +
        '<div class="rel-table-wrap" style="flex:1;min-width:0">' +
        '<table class="rel-table">' +
        '<thead><tr><th>Forma</th><th style="text-align:right">Pedidos</th>' +
        '<th style="text-align:right">Receita</th><th style="text-align:right">Ticket</th>' +
        '<th style="text-align:right">% do total</th></tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '</table>' +
        '</div>' +
        '</div>';

      _makeChart('chart-pagamentos', {
        type: 'doughnut',
        data: {
          labels: rows.map(r => r.forma),
          datasets: [{ data: rows.map(r => r.receita), backgroundColor: CORES,
                       borderWidth: 0, hoverOffset: 4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ctx.label + ': ' + _fmtBRL(ctx.raw) } }
          }
        }
      });
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 1.3 — Attach Rate de Adicionais
  // ════════════════════════════════════════════════════════════════════════════════
  async function _attachRate() {
    const body = _el.querySelector('#body-attach');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/attach-rate' + _params()));
      const data = await r.json();
      const adic = data.adicionais || [];

      if (!adic.length) {
        body.innerHTML = '<div class="rel-empty">Sem adicionais registrados no período.<br>' +
          '<span style="font-size:11px;color:var(--text-dim)">Adicionais aparecem quando o agente WhatsApp os adiciona ao pedido.</span></div>';
        return;
      }

      body.innerHTML =
        '<p style="font-size:11px;color:var(--text-dim);margin-bottom:12px">' +
        'Base: ' + data.total_pedidos + ' pedido' + (data.total_pedidos!==1?'s':'') + ' no período.' +
        '</p>' +
        '<div style="position:relative;height:' + Math.min(adic.length*36+60,360) + 'px">' +
        '<canvas id="chart-attach"></canvas>' +
        '</div>';

      _makeChart('chart-attach', {
        type: 'bar',
        data: {
          labels: adic.map(a => a.nome.length > 28 ? a.nome.slice(0,28)+'…' : a.nome),
          datasets: [{
            label: '% dos pedidos',
            data: adic.map(a => a.pct),
            backgroundColor: 'rgba(0,208,183,0.7)',
            borderRadius: 3,
            indexAxis: 'y',
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label: ctx => {
                const a = adic[ctx.dataIndex];
                return _fmtPct(ctx.raw) + ' dos pedidos (' + a.count + ' pedido' + (a.count!==1?'s':'') + ')';
              }
            }}
          },
          scales: {
            x: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
            y: { ticks: { font: { size: 10 } } }
          }
        }
      });
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 3.2 — ROI de Promoções
  // ════════════════════════════════════════════════════════════════════════════════
  async function _promocoes() {
    const body = _el.querySelector('#body-promo');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/promocoes' + _params()));
      const rows = await r.json();

      if (!rows.length) {
        body.innerHTML = '<div class="rel-empty">Nenhum pedido com promoção aplicada no período.</div>';
        return;
      }

      const tableRows = rows.map(p =>
        '<tr>' +
        '<td style="color:var(--text);font-weight:500">' + _esc(p.nome) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + p.pedidos + '</td>' +
        '<td style="text-align:right;color:var(--teal)">' + _fmtBRL(p.receita_liquida) + '</td>' +
        '<td style="text-align:right;color:#ef4444">−' + _fmtBRL(p.desconto_total) + '</td>' +
        '<td style="text-align:right;color:var(--text-muted)">' + _fmtBRL(p.receita_bruta) + '</td>' +
        '</tr>'
      ).join('');

      body.innerHTML =
        '<div style="position:relative;height:' + Math.min(rows.length*56+80,340) + 'px;margin-bottom:16px">' +
        '<canvas id="chart-promo"></canvas>' +
        '</div>' +
        '<div class="rel-table-wrap">' +
        '<table class="rel-table">' +
        '<thead><tr>' +
        '<th>Promoção</th><th style="text-align:right">Pedidos</th>' +
        '<th style="text-align:right">Receita gerada</th>' +
        '<th style="text-align:right">Desconto dado</th>' +
        '<th style="text-align:right">Bruto s/desconto</th>' +
        '</tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '</table>' +
        '</div>';

      _makeChart('chart-promo', {
        type: 'bar',
        data: {
          labels: rows.map(r => r.nome.length > 22 ? r.nome.slice(0,22)+'…' : r.nome),
          datasets: [
            { label: 'Receita líquida', data: rows.map(r => r.receita_liquida),
              backgroundColor: 'rgba(0,208,183,0.75)', borderRadius: 3 },
            { label: 'Desconto dado',   data: rows.map(r => r.desconto_total),
              backgroundColor: 'rgba(239,68,68,0.7)',  borderRadius: 3 },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: 'top' },
            tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + _fmtBRL(ctx.raw) } }
          },
          scales: {
            y: { ticks: { callback: v => _fmtBRL(v) } }
          }
        }
      });
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // 3.3 — Recompra
  // ════════════════════════════════════════════════════════════════════════════════
  async function _recompra() {
    const body = _el.querySelector('#body-recompra');
    if (!body) return;
    try {
      const r    = await fetch(_api('/api/relatorios/recompra'));
      const data = await r.json();
      const dist  = data.distribuicao || [];
      const total = data.total_clientes || 0;

      const statsHtml = dist.map(d =>
        '<div class="rel-stat-box">' +
        '<span class="rel-stat-value">' + _fmtPct(d.pct) + '</span>' +
        '<span class="rel-stat-label">' + _esc(d.faixa) + ' pedido' + (d.faixa !== '1' ? 's' : '') + '</span>' +
        '<span class="rel-stat-sub">' + d.clientes + ' cliente' + (d.clientes !== 1 ? 's' : '') + '</span>' +
        '</div>'
      ).join('');

      body.innerHTML =
        '<p style="font-size:11px;color:var(--text-dim);margin-bottom:16px">' +
        'Base: ' + total + ' cliente' + (total!==1?'s':'') + ' únicos com pedidos. Agrupados por número (tolerância 9º dígito).' +
        '</p>' +
        '<div class="rel-stats-row">' + statsHtml + '</div>' +
        '<div style="position:relative;height:200px;margin-top:20px">' +
        '<canvas id="chart-recompra"></canvas>' +
        '</div>';

      _makeChart('chart-recompra', {
        type: 'bar',
        data: {
          labels: dist.map(d => d.faixa + ' pedido' + (d.faixa !== '1' ? 's' : '')),
          datasets: [{
            label: 'Clientes',
            data:  dist.map(d => d.clientes),
            backgroundColor: ['rgba(239,68,68,0.7)','rgba(234,179,8,0.75)','rgba(0,208,183,0.75)'],
            borderRadius: 4,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label: ctx => ctx.raw + ' cliente' + (ctx.raw!==1?'s':'') + ' (' + _fmtPct(dist[ctx.dataIndex]?.pct) + ')'
            }}
          },
          scales: { y: { ticks: { stepSize: 1 } } }
        }
      });
    } catch(e) {
      body.innerHTML = '<div class="rel-error">Erro: ' + _esc(e.message) + '</div>';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // Carrega todos os gráficos em paralelo
  // ════════════════════════════════════════════════════════════════════════════════
  async function _carregarTudo() {
    _destroyCharts();
    // Reset bodies to "Carregando..."
    _el.querySelectorAll('.rel-section-body').forEach(b => {
      b.innerHTML = '<div class="rel-loading">Carregando...</div>';
    });
    await Promise.all([
      _heatmap(),
      _abc(),
      _encalhe(),
      _zonas(),
      _pagamentos(),
      _attachRate(),
      _promocoes(),
      _recompra(),
    ]);
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // CSS
  // ════════════════════════════════════════════════════════════════════════════════
  const _CSS = `
    .rel-page {
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      background: var(--bg);
      box-sizing: border-box;
    }
    .rel-page::-webkit-scrollbar { width: 4px; }
    .rel-page::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    .rel-topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 10px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .rel-topbar-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      letter-spacing: -.02em;
    }
    .rel-periodo {
      display: flex;
      gap: 4px;
    }
    .rel-periodo-btn {
      padding: 4px 12px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background .12s, color .12s, border-color .12s;
    }
    .rel-periodo-btn:hover { border-color: var(--teal); color: var(--teal); }
    .rel-periodo-btn.active { background: rgba(0,208,183,.15); border-color: var(--teal); color: var(--teal); }

    .rel-content {
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 28px;
      max-width: 1100px;
      margin: 0 auto;
    }

    .rel-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .rel-section-header {
      padding: 14px 18px 10px;
      border-bottom: 1px solid var(--border);
    }
    .rel-section-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      margin: 0 0 3px;
      letter-spacing: -.01em;
    }
    .rel-section-sub {
      font-size: 11px;
      color: var(--text-dim);
      margin: 0;
      line-height: 1.5;
    }
    .rel-section-body {
      padding: 16px 18px;
      min-height: 80px;
    }

    .rel-loading { color: var(--text-dim); font-size: 12px; text-align: center; padding: 20px; }
    .rel-empty   { color: var(--text-dim); font-size: 12px; text-align: center; padding: 20px; line-height: 1.6; }
    .rel-error   { color: #ef4444; font-size: 12px; text-align: center; padding: 20px; }

    /* Heatmap */
    .rel-heatmap-wrap { overflow-x: auto; }
    .rel-heatmap-grid {
      display: grid;
      gap: 2px;
      min-width: max-content;
    }
    .rel-hm-hlabel {
      font-size: 9px;
      color: var(--text-dim);
      text-align: center;
      height: 20px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding-bottom: 2px;
    }
    .rel-hm-dlabel {
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 6px;
      height: 32px;
      white-space: nowrap;
    }
    .rel-hm-cell {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      font-size: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: default;
      transition: opacity .12s;
    }
    .rel-hm-cell:hover { opacity: .8; }
    .rel-hm-legend {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      font-size: 10px;
      color: var(--text-dim);
    }

    /* Legenda e badges */
    .rel-legend-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .rel-badge {
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
    }

    /* Stats recompra */
    .rel-stats-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .rel-stat-box {
      flex: 1;
      min-width: 100px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 3px;
    }
    .rel-stat-value { font-size: 22px; font-weight: 700; color: var(--text); }
    .rel-stat-label { font-size: 11px; color: var(--text-muted); }
    .rel-stat-sub   { font-size: 10px; color: var(--text-dim); }

    /* Tabelas */
    .rel-table-wrap { overflow-x: auto; }
    .rel-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .rel-table th {
      padding: 6px 10px;
      text-align: left;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .07em;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    .rel-table td {
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255,255,255,.04);
      color: var(--text-muted);
    }
    .rel-table tr:last-child td { border-bottom: none; }
    .rel-table tbody tr:hover td { background: rgba(255,255,255,.03); }
  `;

  let _cssInjected = false;
  function _injectCSS() {
    if (_cssInjected) return;
    const st = document.createElement('style');
    st.id = 'relatorios-css';
    st.textContent = _CSS;
    document.head.appendChild(st);
    _cssInjected = true;
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // Mount / Unmount
  // ════════════════════════════════════════════════════════════════════════════════
  async function mount(el) {
    _injectCSS();
    _el = el;
    _el.style.display = 'flex';
    _el.style.flexDirection = 'column';
    _el.style.height = '100%';
    _el.style.padding = '0';
    _el.classList.add('active');

    _el.innerHTML =
      '<div class="rel-page" id="rel-scroll">' +
      '<div class="rel-topbar">' +
      '<span class="rel-topbar-title">Relatórios & Analytics</span>' +
      '<div class="rel-periodo">' +
      '<button class="rel-periodo-btn" data-dias="7">7d</button>' +
      '<button class="rel-periodo-btn active" data-dias="30">30d</button>' +
      '<button class="rel-periodo-btn" data-dias="90">90d</button>' +
      '<button class="rel-periodo-btn" data-dias="0">Tudo</button>' +
      '</div>' +
      '</div>' +
      '<div class="rel-content">' +
      _secao('heatmap', 'Mapa de Calor — Pedidos por Hora e Dia',
        'Identifique picos de demanda para alocar mão de obra e antecipar preparo. Células quentes (verde escuro) = maior volume de pedidos.') +
      _secao('abc', 'Curva ABC — Produtos por Receita (Pareto)',
        'Os itens da faixa A (verde, até ~80% da receita) merecem atenção máxima em estoque e qualidade. A cauda C (vermelho) é candidata a corte ou simplificação.') +
      _secao('encalhe', 'Produtos Sem Giro',
        'Itens sem venda recente são estoque morto: insumo que estraga, ocupa geladeira e gera prejuízo silencioso. Vermelho = +30 dias sem venda. Laranja = +14 dias.') +
      _secao('zonas', 'Rentabilidade por Zona de Entrega',
        'Zonas com muitos pedidos e taxa baixa podem entregar no prejuízo. Ajuste o pedido mínimo ou a taxa por bairro conforme a receita gerada.') +
      _secao('pagamentos', 'Mix de Pagamento',
        'PIX tem custo zero; cartão online tem taxa de processamento; dinheiro tem risco de troco. Conhecer o mix ajuda a calcular a margem real e a incentivar o meio mais barato.') +
      _secao('attach', 'Taxa de Anexação de Adicionais',
        'Adicionais têm quase margem pura — insumo barato, preço alto. Attach rate baixo em adicionais de alta margem = dinheiro fácil ficando na mesa. Instrua o bot a oferecer os de maior performance.') +
      _secao('promo', 'ROI de Promoções e Cupons',
        'Verde = receita gerada; vermelho = desconto concedido. Se o desconto supera o incremento de margem, a promoção está dando lucro de graça — redesenhe ou elimine.') +
      _secao('recompra', 'Retenção e Recompra de Clientes',
        'Balde furado: atrair cliente que pede uma vez e some é queimar dinheiro. Recompra baixa indica problema de experiência, não de aquisição. Acione cupom de retorno para quem não pede há 30+ dias.') +
      '</div>' +
      '</div>';

    // Period selector
    _el.querySelectorAll('.rel-periodo-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        _el.querySelectorAll('.rel-periodo-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _periodo = btn.dataset.dias;
        await _carregarTudo();
      });
    });

    try {
      await _loadChartJS();
    } catch(e) {
      console.warn('[Relatorios] Chart.js não carregou:', e.message);
    }

    await _carregarTudo();
  }

  function unmount(el) {
    _destroyCharts();
    if (el) { el.style.display = 'none'; el.classList.remove('active'); }
  }

  return { mount, unmount };
})();
