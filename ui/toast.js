// Sistema de toasts — window.Toast.success(msg) / .error(msg) / .warn(msg)
(function() {
  let container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = `
        position: fixed; bottom: 24px; right: 24px;
        display: flex; flex-direction: column; gap: 8px;
        z-index: 9999; pointer-events: none;
      `;
      document.body.appendChild(container);
    }
    return container;
  }

  function show(msg, type) {
    const colors = { success: '#22c55e', error: '#ef4444', warn: '#f59e0b' };
    const color = colors[type] || colors.success;

    const toast = document.createElement('div');
    toast.style.cssText = `
      width: 320px; min-height: 52px;
      background: #0a0a0a; border: 1px solid #1a1a1a;
      border-left: 3px solid ${color};
      padding: 12px 16px;
      display: flex; align-items: center; gap: 10px;
      font-family: 'Inter', sans-serif; font-size: 13px; color: #fff;
      pointer-events: all; cursor: pointer;
      transform: translateX(360px);
      transition: transform 0.25s ease;
      letter-spacing: -0.01em; line-height: 1.4;
    `;
    toast.textContent = msg;
    toast.onclick = () => dismiss(toast);

    getContainer().appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });
    });

    setTimeout(() => dismiss(toast), 4000);
  }

  function dismiss(toast) {
    toast.style.transform = 'translateX(360px)';
    setTimeout(() => toast.remove(), 260);
  }

  window.Toast = {
    success: (msg) => show(msg, 'success'),
    error:   (msg) => show(msg, 'error'),
    warn:    (msg) => show(msg, 'warn'),
  };
})();
