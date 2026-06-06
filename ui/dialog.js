/**
 * Dialog — sistema de diálogos in-app do CEIA OS
 *
 * API:
 *   await Dialog.confirm({ title, message, confirmText, cancelText, danger })  → boolean
 *   await Dialog.alert({ title, message, okText })                             → void
 *   await Dialog.prompt({ title, message, placeholder, defaultValue,
 *                         confirmText, cancelText })                           → string | null
 */
const Dialog = (() => {
  /* ── Escape HTML ─────────────────────────────────────────────────────────── */
  function h(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Core open ───────────────────────────────────────────────────────────── */
  let _uid = 0;

  function open(innerHtml, setup) {
    return new Promise(resolve => {
      const id         = `dlg-${++_uid}`;
      const prevFocus  = document.activeElement;

      /* Overlay */
      const overlay = document.createElement('div');
      overlay.className = 'dlg-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = innerHtml;
      document.body.appendChild(overlay);

      /* Animate in */
      requestAnimationFrame(() => overlay.classList.add('dlg-open'));

      /* Close handler */
      let closed = false;
      function close(value) {
        if (closed) return;
        closed = true;
        cleanup();
        overlay.classList.remove('dlg-open');
        setTimeout(() => {
          overlay.remove();
          prevFocus?.focus();
          resolve(value);
        }, 180);
      }

      /* Backdrop click */
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });

      /* Esc key */
      function onEsc(e) { if (e.key === 'Escape') close(null); }
      document.addEventListener('keydown', onEsc, true);

      /* Focus trap */
      function onTab(e) {
        if (e.key !== 'Tab') return;
        const els = [...overlay.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])'
        )];
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
        else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
      }
      overlay.addEventListener('keydown', onTab);

      function cleanup() {
        document.removeEventListener('keydown', onEsc, true);
      }

      /* Delegate to caller for button wiring + initial focus */
      setup(overlay, close, id);
    });
  }

  /* ── confirm ─────────────────────────────────────────────────────────────── */
  function confirm({
    title       = 'Confirmar',
    message     = '',
    confirmText = 'Confirmar',
    cancelText  = 'Cancelar',
    danger      = false,
  } = {}) {
    return open(`
      <div class="dlg-card" role="document">
        <h2 class="dlg-title">${h(title)}</h2>
        <p  class="dlg-message">${h(message)}</p>
        <div class="dlg-footer">
          <button class="dlg-btn dlg-btn-cancel"  data-dlg="cancel">${h(cancelText)}</button>
          <button class="dlg-btn ${danger ? 'dlg-btn-danger' : 'dlg-btn-primary'}" data-dlg="confirm">${h(confirmText)}</button>
        </div>
      </div>`, (overlay, close) => {
        overlay.querySelector('[data-dlg="confirm"]').onclick = () => close(true);
        overlay.querySelector('[data-dlg="cancel"]').onclick  = () => close(false);
        overlay.querySelector('[data-dlg="confirm"]').focus();
    });
  }

  /* ── alert ───────────────────────────────────────────────────────────────── */
  function alert({
    title  = 'Atenção',
    message = '',
    okText  = 'Entendi',
  } = {}) {
    return open(`
      <div class="dlg-card" role="document">
        <h2 class="dlg-title">${h(title)}</h2>
        <p  class="dlg-message">${h(message)}</p>
        <div class="dlg-footer">
          <button class="dlg-btn dlg-btn-primary" data-dlg="ok">${h(okText)}</button>
        </div>
      </div>`, (overlay, close) => {
        overlay.querySelector('[data-dlg="ok"]').onclick = () => close();
        overlay.querySelector('[data-dlg="ok"]').focus();
    });
  }

  /* ── prompt ──────────────────────────────────────────────────────────────── */
  function prompt({
    title        = 'Entrada',
    message      = '',
    placeholder  = '',
    defaultValue = '',
    confirmText  = 'Confirmar',
    cancelText   = 'Cancelar',
  } = {}) {
    return open(`
      <div class="dlg-card" role="document">
        <h2 class="dlg-title">${h(title)}</h2>
        <p  class="dlg-message">${h(message)}</p>
        <input type="text" class="dlg-input" data-dlg="input"
               placeholder="${h(placeholder)}" value="${h(defaultValue)}" autocomplete="off">
        <div class="dlg-footer">
          <button class="dlg-btn dlg-btn-cancel"  data-dlg="cancel">${h(cancelText)}</button>
          <button class="dlg-btn dlg-btn-primary"  data-dlg="confirm">${h(confirmText)}</button>
        </div>
      </div>`, (overlay, close) => {
        const input = overlay.querySelector('[data-dlg="input"]');
        overlay.querySelector('[data-dlg="confirm"]').onclick = () => close(input.value);
        overlay.querySelector('[data-dlg="cancel"]').onclick  = () => close(null);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        });
        input.focus();
        input.select();
    });
  }

  /* ── modal (visualização longa — usado em Atendimentos) ─────────────────── */
  function modal(innerHtml) {
    return open(`
      <div class="dlg-card dlg-card--modal" role="document">
        <div class="dlg-modal-topbar">
          <button class="dlg-modal-close" data-dlg="close" aria-label="Fechar">×</button>
        </div>
        <div class="dlg-modal-body">${innerHtml}</div>
      </div>`, (overlay, close) => {
        overlay.querySelector('[data-dlg="close"]').onclick = () => close();
        overlay.querySelector('[data-dlg="close"]').focus();
    });
  }

  return { confirm, alert, prompt, modal };
})();

window.Dialog = Dialog;
