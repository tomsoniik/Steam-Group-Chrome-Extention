'use strict';

/**
 * Right-edge dock: a slim icon rail with a flyout panel to its left.
 *   rail    search by tag, my groups, settings (bottom), collapse chevron (top)
 *   panel   opens next to the rail; Esc, the X button or a click outside closes it
 *   tab     when collapsed, a small handle on the right edge brings the rail back
 *
 * Rendered in a shadow root so Steam's stylesheet cannot leak in (Steam dims disabled
 * buttons, restyles inputs, ...). Panels are built on open, nothing runs while closed.
 * Collapsed state lives in storage key `d`, separate from settings, so toggling it does not
 * rebuild the page view.
 */
(() => {
  const DOCK_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.dock {
  --accent: #66c0f4;
  --accent-soft: rgba(102, 192, 244, 0.14);
  --text: #c6d4df;
  --strong: #eef3f7;
  --muted: #8f98a0;
  --rail: #0e1319;
  --panel: #141a22;
  --raised: #1b232d;
  --line: rgba(255, 255, 255, 0.07);
  --danger: #e07a72;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  position: fixed;
  top: 112px;
  right: 0;
  z-index: 2147482000;
  font: 13px/1.45 "Motiva Sans", Arial, Helvetica, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; }
.ico { width: 18px; height: 18px; flex: none; }

/* rail */
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 52px;
  padding: 6px 0 8px;
  border: 1px solid var(--line);
  border-right: 0;
  border-radius: 8px 0 0 8px;
  background: var(--rail);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.35);
  transition: transform 260ms var(--ease), opacity 200ms var(--ease);
}
.rail-sep { width: 24px; height: 1px; margin: 6px 0; background: var(--line); }
.rail-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  transition: background-color 160ms var(--ease), color 160ms var(--ease), transform 120ms var(--ease);
}
.rail-btn:hover { background: var(--accent-soft); }
.rail-btn:active { transform: scale(0.94); }
.rail-btn[aria-expanded="true"] { background: var(--accent); color: #0e141b; }
.rail-btn.ghost { width: 32px; height: 26px; color: var(--muted); }
.rail-btn.ghost:hover { color: var(--strong); background: rgba(255, 255, 255, 0.06); }
.rail-btn.ghost .ico { width: 14px; height: 14px; }
.rail-btn:focus-visible, .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* tooltip, shown to the left of rail buttons */
.rail-btn[data-tip]:hover::after,
.rail-btn[data-tip]:focus-visible::after {
  content: attr(data-tip);
  position: absolute;
  right: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%);
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--raised);
  color: var(--strong);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
.dock.has-panel .rail-btn::after { display: none; }

/* collapsed: rail slides out, a small tab stays */
.tab {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  place-items: center;
  width: 22px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--line);
  border-right: 0;
  border-radius: 6px 0 0 6px;
  background: var(--rail);
  color: var(--accent);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms var(--ease), width 160ms var(--ease);
}
.tab:hover { width: 28px; }
.tab .ico { width: 14px; height: 14px; }
.dock.collapsed .rail { transform: translateX(100%); opacity: 0; pointer-events: none; }
.dock.collapsed .tab { opacity: 1; pointer-events: auto; }

/* panel */
.panel {
  position: absolute;
  top: 0;
  right: 60px;
  width: 300px;
  max-height: calc(100vh - 140px);
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  animation: in 220ms var(--ease);
}
@keyframes in { from { opacity: 0; transform: translateX(10px); } }
.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px 12px 16px;
  border-bottom: 1px solid var(--line);
}
.panel-head .ico { color: var(--accent); }
.panel-title { margin: 0; color: var(--strong); font-size: 14px; font-weight: 500; flex: 1; }
.x {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.x:hover { background: rgba(255, 255, 255, 0.06); color: var(--strong); }
.x .ico { width: 14px; height: 14px; }
.panel-body { display: grid; gap: 16px; padding: 16px; }
.section { display: grid; gap: 8px; }
.label { color: var(--strong); font-weight: 500; }
.hint { margin: 0; color: var(--muted); font-size: 12px; }

/* fields */
.field { display: flex; gap: 8px; }
.input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: #0b1016;
  color: var(--strong);
  font: 500 13px ui-monospace, Consolas, monospace;
}
.input::placeholder { color: #6f7a84; }
.input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 160ms var(--ease), transform 120ms var(--ease);
}
.btn:hover { background: rgba(255, 255, 255, 0.06); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible, .x:focus-visible, .seg button:focus-visible, .switch:focus-visible, .link:focus-visible, .input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn.primary { border-color: transparent; background: var(--accent); color: #0e141b; }
.btn.primary:hover { background: #7fcbf6; }
.btn.block { width: 100%; }
.btn .ico { width: 15px; height: 15px; }

/* stats */
.stats { display: grid; gap: 2px; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: rgba(0, 0, 0, 0.18); }
.stat { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 10px; border-radius: 4px; }
.stat:hover { background: rgba(255, 255, 255, 0.03); }
.stat-name { flex: 1; }
.stat-num { color: var(--strong); font: 500 13px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
.stat-num.unknown { color: var(--muted); }
.link {
  min-width: 64px;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--accent);
  text-align: right;
  cursor: pointer;
}
.link:hover:not(:disabled) { background: var(--accent-soft); }
.link.armed { color: var(--danger); }
.link:disabled { color: var(--muted); opacity: 0.5; cursor: default; }

/* segmented + switch */
.seg {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #0b1016;
}
.seg button {
  height: 28px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--muted);
  font: 500 12px ui-monospace, Consolas, monospace;
  cursor: pointer;
}
.seg button:hover { color: var(--strong); }
.seg button[aria-checked="true"] { background: var(--raised); color: var(--accent); box-shadow: inset 0 0 0 1px rgba(102, 192, 244, 0.35); }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.switch {
  appearance: none;
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  margin: 1px 0 0;
  border-radius: 10px;
  background: #3a4552;
  cursor: pointer;
  transition: background-color 180ms var(--ease);
}
.switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--strong);
  transition: transform 220ms var(--ease);
}
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(14px); background: #0e141b; }
.divider { height: 1px; background: var(--line); }

@media (prefers-reduced-motion: reduce) {
  .rail, .tab, .switch, .switch::after, .rail-btn, .btn { transition: none; }
  .panel { animation: none; }
}
`;

  const t = (k, s) => SGT.t(k, s);
  const STORAGE_KEY = 'd';
  const PANELS = {
    search: { icon: 'search', title: 'searchTitle', nav: 'navSearch' },
    groups: { icon: 'users', title: 'navGroups', nav: 'navGroups' },
    settings: { icon: 'gear', title: 'navSettings', nav: 'navSettings' },
  };

  let host;
  let root;
  let dockEl;
  let panelEl = null;
  let openName = null;
  let collapsed = false;
  let lastTrigger = null;

  const el = (tag, props, ...children) => {
    const n = h(tag, props, ...children);
    return n;
  };
  const icon = (name) => {
    const svg = SGT.icon(name);
    svg.setAttribute('class', 'ico');
    return svg;
  };

  const saveSettings = (patch) => {
    const s = { ...SGT.store.settings, ...patch };
    return chrome.storage.local.set({ s });
  };

  /* ---------- panels ---------- */

  const segControl = (labelId, options, value, onPick) => {
    const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': labelId });
    const paint = (v) => {
      for (const b of seg.children) {
        const on = b.dataset.v === String(v);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    };
    for (const [v, label] of options) seg.append(el('button', { type: 'button', role: 'radio', 'data-v': String(v) }, label));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      paint(b.dataset.v);
      onPick(b.dataset.v);
    });
    seg.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const btns = [...seg.children];
      const i = btns.indexOf(root.activeElement);
      const next = btns[(i + (e.key === 'ArrowLeft' ? -1 : 1) + btns.length) % btns.length];
      next.focus();
      next.click();
    });
    paint(value);
    return seg;
  };

  /** Two-step destructive link: first click arms it for 3 s, second click runs it. */
  const twoStep = (label, run) => {
    const b = el('button', { type: 'button', class: 'link' }, label);
    let timer = 0;
    b.addEventListener('click', async () => {
      if (!timer) {
        b.classList.add('armed');
        b.textContent = `${label}?`;
        timer = setTimeout(() => {
          timer = 0;
          b.classList.remove('armed');
          b.textContent = label;
        }, 3000);
        return;
      }
      clearTimeout(timer);
      timer = 0;
      await run();
      b.classList.remove('armed');
      b.textContent = t('popupCleared');
      b.disabled = true;
    });
    return b;
  };

  const statRow = (name, value, action) => el('div', { class: 'stat' },
    el('span', { class: 'stat-name' }, name),
    value == null
      ? el('span', { class: 'stat-num unknown', title: t('statUnknown') }, '?')
      : el('span', { class: 'stat-num' }, String(value)),
    action || null);

  const buildSearch = () => {
    const input = el('input', {
      class: 'input', id: 'sgt-q', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: t('searchPh'),
    });
    const go = () => {
      const q = input.value.trim();
      if (!q) {
        input.focus();
        return;
      }
      location.assign(`${SGT.ORIGIN}/search/groups/?text=${encodeURIComponent(q)}`);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    if (SGT.PAGE === 'search') input.value = document.querySelector(SGT.sel.searchBox)?.value || '';
    return [
      el('div', { class: 'section' },
        el('label', { class: 'label', for: 'sgt-q' }, t('searchLabel')),
        el('div', { class: 'field' }, input,
          el('button', { type: 'button', class: 'btn primary', onclick: go }, icon('search'), t('searchGo')))),
      el('p', { class: 'hint' }, t('searchHint')),
    ];
  };

  const buildGroups = () => {
    const s = SGT.store;
    return [
      el('div', { class: 'stats' },
        statRow(t('statMember'), s.members ? s.members.size : null),
        statRow(t('statPinned'), s.pins.size, s.pins.size
          ? twoStep(t('popupClear'), () => chrome.storage.local.set({ p: [] }))
          : null),
        statRow(t('statCached'), s.tags.size, s.tags.size
          ? twoStep(t('popupClear'), () => chrome.storage.local.remove('t'))
          : null)),
      s.members ? null : el('p', { class: 'hint' }, t('statUnknown')),
      el('button', {
        type: 'button', class: 'btn primary block', onclick: () => location.assign(`${SGT.ORIGIN}/my/groups/`),
      }, icon('users'), t('popupOpen')),
    ];
  };

  const buildSettings = () => {
    const s = SGT.store.settings;
    const tags = el('input', { type: 'checkbox', class: 'switch', id: 'sgt-tags', role: 'switch' });
    tags.checked = s.tags;
    tags.addEventListener('change', () => saveSettings({ tags: tags.checked }));
    return [
      el('div', { class: 'section' },
        el('span', { class: 'label', id: 'sgt-lang' }, t('langLabel')),
        segControl('sgt-lang', Object.entries(SGT_LANGS), s.lang, (v) => saveSettings({ lang: v }))),
      el('div', { class: 'divider' }),
      el('div', { class: 'row' },
        el('div', { class: 'section' },
          el('label', { class: 'label', for: 'sgt-tags' }, t('popupTags')),
          el('p', { class: 'hint' }, t('popupTagsHint'))),
        tags),
      el('div', { class: 'section' },
        el('span', { class: 'label', id: 'sgt-delay' }, t('popupDelay')),
        segControl('sgt-delay', [[800, '0.8 s'], [1200, '1.2 s'], [2000, '2 s'], [3500, '3.5 s']], s.delay,
          (v) => saveSettings({ delay: Number(v) })),
        el('p', { class: 'hint' }, t('popupDelayHint'))),
      el('div', { class: 'section' },
        el('span', { class: 'label', id: 'sgt-ttl' }, t('popupTtl')),
        segControl('sgt-ttl', [1, 7, 30].map((d) => [d, `${d} ${t('popupDays')}`]), s.ttl,
          (v) => saveSettings({ ttl: Number(v) }))),
    ];
  };

  const BUILDERS = { search: buildSearch, groups: buildGroups, settings: buildSettings };

  /* ---------- open / close ---------- */

  const onOutside = (e) => {
    if (!e.composedPath().includes(host)) closePanel();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closePanel();
      lastTrigger?.focus();
    }
  };

  function closePanel() {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = null;
    openName = null;
    dockEl.classList.remove('has-panel');
    for (const b of root.querySelectorAll('[data-panel]')) b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function openPanel(name, { focus = true } = {}) {
    const keepScroll = openName === name ? panelEl?.scrollTop : 0;
    if (panelEl) panelEl.remove();
    const def = PANELS[name];
    openName = name;
    panelEl = el('section', { class: 'panel', role: 'region', 'aria-labelledby': 'sgt-panel-title' },
      el('div', { class: 'panel-head' },
        icon(def.icon),
        el('h2', { class: 'panel-title', id: 'sgt-panel-title' }, t(def.title)),
        el('button', { type: 'button', class: 'x', 'aria-label': t('close'), onclick: () => { closePanel(); lastTrigger?.focus(); } }, icon('x'))),
      el('div', { class: 'panel-body' }, ...BUILDERS[name]()));
    dockEl.append(panelEl);
    panelEl.scrollTop = keepScroll || 0;
    dockEl.classList.add('has-panel');
    for (const b of root.querySelectorAll('[data-panel]')) {
      b.setAttribute('aria-expanded', String(b.dataset.panel === name));
    }
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    if (focus) panelEl.querySelector('input, button:not(.x)')?.focus();
  }

  const setCollapsed = (v) => {
    collapsed = v;
    if (v) closePanel();
    dockEl.classList.toggle('collapsed', v);
    root.querySelector('.rail').inert = v;
    root.querySelector('.tab').inert = !v;
    chrome.storage.local.set({ [STORAGE_KEY]: { c: v } });
  };

  /* ---------- render ---------- */

  const railBtn = (name) => el('button', {
    type: 'button',
    class: 'rail-btn',
    'data-panel': name,
    'data-tip': t(PANELS[name].nav),
    'aria-label': t(PANELS[name].nav),
    'aria-expanded': 'false',
  }, icon(PANELS[name].icon));

  function render() {
    const reopen = openName;
    closePanel();
    root.replaceChildren();
    root.append(el('style', null, DOCK_CSS));
    const collapseBtn = el('button', {
      type: 'button', class: 'rail-btn ghost', 'aria-label': t('dockHide'), 'data-tip': t('dockHide'),
      onclick: () => setCollapsed(true),
    }, icon('caretRight'));
    const rail = el('nav', { class: 'rail', 'aria-label': t('dockLabel') },
      collapseBtn,
      el('div', { class: 'rail-sep' }),
      railBtn('search'),
      railBtn('groups'),
      el('div', { class: 'rail-sep' }),
      railBtn('settings'));
    rail.addEventListener('click', (e) => {
      const b = e.target.closest('[data-panel]');
      if (!b) return;
      lastTrigger = b;
      if (openName === b.dataset.panel) closePanel();
      else openPanel(b.dataset.panel);
    });
    const tab = el('button', {
      type: 'button', class: 'tab', 'aria-label': t('dockShow'), title: t('dockShow'),
      onclick: () => {
        setCollapsed(false);
        root.querySelector('[data-panel]')?.focus();
      },
    }, icon('caretLeft'));
    dockEl = el('div', { class: `dock${collapsed ? ' collapsed' : ''}` }, rail, tab);
    root.append(dockEl);
    rail.inert = collapsed;
    tab.inert = !collapsed;
    if (reopen && !collapsed) openPanel(reopen, { focus: false });
  }

  SGT.dock = {
    async mount() {
      if (host) return;
      const { [STORAGE_KEY]: d } = await chrome.storage.local.get(STORAGE_KEY);
      collapsed = !!d?.c;
      host = document.createElement('div');
      host.id = 'sgt-dock';
      root = host.attachShadow({ mode: 'open' });
      render();
      document.body.append(host);
    },
    /** Storage changed: re-render on language change, refresh open panel values otherwise. */
    onChange(changes) {
      if (!host) return;
      if (changes.s && changes.s.oldValue?.lang !== changes.s.newValue?.lang) {
        render();
        return;
      }
      if (openName && (changes.p || changes.t || changes.m || changes.s)) {
        // Settings panel controls already show the new value; avoid stealing focus mid-click.
        if (openName === 'settings' && !changes.p && !changes.t) return;
        openPanel(openName, { focus: false });
      }
    },
  };
})();
