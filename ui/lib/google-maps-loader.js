/**
 * CeiaGMaps — loader compartilhado do Google Maps JS SDK
 * Carrega UMA única vez com libraries=drawing,places,geometry
 * Usado por: Zonas de Entrega, Despacho (Places Autocomplete)
 */
window.CeiaGMaps = (() => {
  let _loadPromise = null;
  let _key         = null;

  function apiBase() { return (window.CEIA?.apiBase) || 'http://127.0.0.1:3000'; }

  /**
   * load() → Promise<void>
   * Resolve quando o SDK estiver pronto.
   * Rejeita se a chave não estiver configurada ou houver erro de rede.
   */
  async function load() {
    // Já carregado?
    if (window.google?.maps?.places) return;

    // Carregamento em progresso — retorna a mesma promise
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      // Busca a chave
      if (!_key) {
        const r = await fetch(apiBase() + '/api/settings/google_maps_key').catch(() => null);
        const d = r?.ok ? await r.json() : null;
        _key = d?.key?.trim() || '';
      }
      if (!_key) throw new Error('Chave Google Maps não configurada');

      // Se o SDK já foi injetado (por outra instância antes do load terminar)
      if (window.google?.maps) return;

      await new Promise((resolve, reject) => {
        // Script já no DOM mas callback ainda não disparou?
        if (document.getElementById('gmap-sdk')) {
          // Aguarda o callback global
          const prev = window._ceiaGMapsReady;
          window._ceiaGMapsReady = () => { if (prev) prev(); resolve(); };
          return;
        }

        window._ceiaGMapsReady = resolve;
        const s = document.createElement('script');
        s.id    = 'gmap-sdk';
        s.async = true;
        s.defer = true;
        s.src   = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(_key)}&libraries=places,geometry&callback=_ceiaGMapsReady`;
        s.onerror = () => { _loadPromise = null; reject(new Error('Falha ao carregar Google Maps SDK')); };
        document.head.appendChild(s);
      });
    })();

    return _loadPromise;
  }

  /** Retorna a chave carregada (ou null se ainda não carregou) */
  function getKey() { return _key; }

  return { load, getKey };
})();
