/** Per-tab attribution, scoped to this game. No identifiers are merged across sites. */
export function createAttribution(win = globalThis) {
  const campaignKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const clean = (value) => typeof value === 'string' && /^[a-zA-Z0-9 _.:+-]{1,100}$/.test(value) ? value : undefined;
  const validId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  let context;
  return function attributionProperties() {
    try {
      if (win.navigator?.globalPrivacyControl === true || win.navigator?.doNotTrack === '1' || win.doNotTrack === '1') return {};
      const now = Date.now();
      const url = new URL(win.location.href);
      const storageKey = 'inspire:launch:v2:' + url.pathname.split('/').filter(Boolean)[0];
      if (!context) {
        let saved;
        try { saved = JSON.parse(win.sessionStorage.getItem(storageKey) || 'null'); } catch { /* storage optional */ }
        const props = { attribution_version: 'v2' };
        let expires = now + 1800000;
        if (saved && typeof saved.expires === 'number' && saved.expires > now && saved.expires <= now + 1800000) {
          expires = saved.expires;
          campaignKeys.forEach(k => { const value = clean(saved.props?.[k]); if (value) props[k] = value; });
          if (validId(saved.props?.launch_id)) props.launch_id = saved.props.launch_id;
          const placement = clean(saved.props?.cta_location);
          if (placement) props.cta_location = placement;
        }
        campaignKeys.forEach(k => { const value = clean(url.searchParams.get(k)); if (value) props[k] = value; });
        const hash = new URLSearchParams(url.hash.slice(1));
        const id = hash.get('inspire_launch_id');
        const at = Number(hash.get('inspire_launch_at'));
        if (validId(id) && at > 0 && at <= now + 60000 && now - at < 1800000) {
          props.launch_id = id;
          expires = Math.min(now + 1800000, at + 1800000);
          const placement = clean(hash.get('inspire_cta'));
          if (placement) props.cta_location = placement;
        }
        if (hash.has('inspire_launch_id') || hash.has('inspire_launch_at') || hash.has('inspire_cta')) {
          ['inspire_launch_id', 'inspire_launch_at', 'inspire_cta'].forEach(k => hash.delete(k));
          url.hash = hash.toString();
          try { win.history.replaceState(win.history.state, '', url.href); } catch { /* optional cleanup */ }
        }
        context = { expires, props };
        try { win.sessionStorage.setItem(storageKey, JSON.stringify(context)); } catch { /* memory fallback */ }
      }
      if (context.expires <= now) return { attribution_version: 'v2' };
      return { ...context.props };
    } catch { return {}; }
  };
}
