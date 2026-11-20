'use strict';

/** Tiny DOM helper. No framework: the content script stays a few KB. */
const h = (tag, props, ...children) => {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
};

/** Native append()/replaceChildren() stringify null, so drop empty slots first. */
const kids = (...a) => a.filter((x) => x != null && x !== false);

const iconCache = new Map();
SGT.icon = (name) => {
  let tpl = iconCache.get(name);
  if (!tpl) {
    const NS = 'http://www.w3.org/2000/svg';
    tpl = document.createElementNS(NS, 'svg');
    tpl.setAttribute('viewBox', '0 0 256 256');
    tpl.setAttribute('fill', 'currentColor');
    tpl.setAttribute('aria-hidden', 'true');
    tpl.setAttribute('class', 'sgt-ico');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', SGT.ICON_PATHS[name]);
    tpl.append(p);
    iconCache.set(name, tpl);
  }
  return tpl.cloneNode(true);
};

SGT.ui = {};

/* ---------- tag badge ---------- */

SGT.ui.badge = () => h('span', { class: 'sgt-tag is-loading', 'aria-hidden': 'true' });

/** Fill a badge. '' or null removes it (no tag / fetch failed). */
SGT.ui.setBadge = (el, tag) => {
  if (!tag) {
    el.remove();
    return;
  }
  el.className = 'sgt-tag';
  el.textContent = tag;
  el.removeAttribute('aria-hidden');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('title', SGT.t('tagCopy'));
  el.dataset.tag = tag;
};

/** Mark a badge as sharing its tag with other groups (names listed in the tooltip). */
SGT.ui.setDup = (el, others) => {
  if (!el?.dataset.tag) return;
  el.classList.toggle('is-dup', !!others);
  el.title = others ? SGT.t('dupOf', [others.join(', ')]) : SGT.t('tagCopy');
};

/* ---------- pin ---------- */

SGT.ui.pin = (gid, pinned) => {
  const b = h('button', { type: 'button', class: 'sgt-pin sgt-side', 'data-gid': gid });
  SGT.ui.setPin(b, pinned);
  return b;
};

SGT.ui.setPin = (b, pinned) => {
  b.classList.toggle('is-on', pinned);
  b.setAttribute('aria-pressed', String(pinned));
  const label = SGT.t(pinned ? 'unpin' : 'pin');
  b.setAttribute('aria-label', label);
  b.title = label;
  b.replaceChildren(SGT.icon(pinned ? 'pinFill' : 'pin'));
};

/* ---------- join ---------- */

const JOIN_VIEW = {
  idle: { icon: 'plus', label: 'join' },
  idlePrivate: { icon: 'plus', label: 'request' },
  busy: { icon: null, label: 'joining' },
  member: { icon: 'check', label: 'member' },
  requested: { icon: 'clock', label: 'requested' },
  failed: { icon: 'retry', label: 'retry' },
  invite: { icon: 'lock', label: 'inviteOnly' },
};

SGT.ui.join = (state, isPrivate) => {
  const b = h('button', { type: 'button', class: 'sgt-join sgt-side' });
  b.dataset.private = isPrivate ? '1' : '';
  SGT.ui.setJoin(b, state);
  return b;
};

SGT.ui.setJoin = (b, state) => {
  const key = state === 'idle' && b.dataset.private ? 'idlePrivate' : state;
  const v = JOIN_VIEW[key];
  b.dataset.state = state;
  b.disabled = state === 'busy' || state === 'member' || state === 'requested' || state === 'invite';
  b.setAttribute('aria-busy', String(state === 'busy'));
  b.replaceChildren(
    v.icon ? SGT.icon(v.icon) : h('span', { class: 'sgt-spin', 'aria-hidden': 'true' }),
    h('span', null, SGT.t(v.label)),
  );
  b.title = state === 'failed' ? SGT.t('joinFailed') : state === 'invite' ? SGT.t('inviteOnlyTitle') : '';
};

/* ---------- list toolbar (group lists) ---------- */

const seg = (name, options, onPick) => {
  const el = h('div', { class: 'sgt-seg', role: 'radiogroup', 'aria-label': SGT.t(name) });
  for (const [value, label] of options) {
    el.append(h('button', { type: 'button', role: 'radio', 'data-v': value }, SGT.t(label)));
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.getAttribute('aria-checked') !== 'true') onPick(b.dataset.v);
  });
  return {
    el,
    set(value) {
      for (const b of el.children) b.setAttribute('aria-checked', String(b.dataset.v === value));
    },
  };
};

SGT.ui.listBar = ({ owner, onSort, onDup, onLeaveAll }) => {
  const count = h('span', { class: 'sgt-bar-count', 'aria-live': 'polite' });
  const sort = seg('sortLabel', [['default', 'sortDefault'], ['tag', 'sortTag']], onSort);
  const dup = h('button', { type: 'button', class: 'sgt-btn sgt-toggle', 'aria-pressed': 'false', onclick: () => onDup() },
    SGT.icon('dup'), h('span', null, SGT.t('onlyDups')));
  const leave = owner && h('button', { type: 'button', class: 'sgt-btn sgt-btn-danger', onclick: onLeaveAll },
    SGT.icon('signOut'), h('span', null, SGT.t('leaveAll')));
  const el = h('div', { class: 'sgt-bar', role: 'toolbar', 'aria-label': SGT.t('extName') },
    count, h('div', { class: 'sgt-bar-actions' }, ...kids(sort.el, dup, leave)));

  let counts = { total: 0, pinned: 0, dups: 0 };
  let progress = null;
  const paint = () => {
    if (progress) {
      count.textContent = SGT.t('loadingTags', [String(progress[0]), String(progress[1])]);
      return;
    }
    const parts = [SGT.t('countGroups', [String(counts.total)])];
    if (owner) parts.push(SGT.t('countPinned', [String(counts.pinned)]));
    if (counts.dups) parts.push(SGT.t('countDups', [String(counts.dups)]));
    count.textContent = parts.join(', ');
  };

  return {
    el,
    setCounts(c) {
      counts = c;
      if (leave) leave.disabled = c.total - c.pinned <= 0;
      paint();
    },
    setProgress(done, total) {
      progress = total ? [done, total] : null;
      paint();
    },
    setSort: (v) => sort.set(v),
    setDup(on) {
      dup.setAttribute('aria-pressed', String(on));
    },
  };
};

/* ---------- search toolbar (/search/groups) ---------- */

SGT.ui.searchBar = ({ onFilter, onMore }) => {
  const input = h('input', {
    class: 'sgt-filter-input',
    type: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': SGT.t('tagFilter'),
    placeholder: SGT.t('tagFilterPh'),
  });
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => onFilter(input.value), 120);
  });
  const count = h('span', { class: 'sgt-bar-count', 'aria-live': 'polite' });
  const more = h('button', { type: 'button', class: 'sgt-btn', onclick: onMore },
    SGT.icon('more'), h('span', null, SGT.t('loadMore')));
  const el = h('div', { class: 'sgt-bar sgt-bar-search', role: 'toolbar', 'aria-label': SGT.t('extName') },
    h('label', { class: 'sgt-filter' }, SGT.icon('filter'), input),
    count,
    more);
  return {
    el,
    setCount(text) {
      count.textContent = text;
    },
    setMore(state) {
      more.disabled = state !== 'idle';
      more.hidden = state === 'hidden';
      more.lastChild.textContent = SGT.t(state === 'busy' ? 'loadingMore' : state === 'end' ? 'noMore' : 'loadMore');
    },
  };
};

/* ---------- toast ---------- */

let toastEl;
let toastTimer;
SGT.ui.toast = (msg, icon = 'check') => {
  if (!toastEl) {
    toastEl = h('div', { class: 'sgt-toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.replaceChildren(SGT.icon(icon), h('span', null, msg));
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2200);
};

/* ---------- leave dialog ---------- */

const CONFIRM_TYPED_OVER = 10;

/**
 * One native <dialog> that moves through three states: confirm, progress, done.
 * showModal() gives focus trapping and Esc handling for free.
 */
SGT.ui.leaveDialog = ({ count, pinned, onConfirm, onCancel }) => {
  const word = SGT.t('confirmWord');
  const needsTyping = count > CONFIRM_TYPED_OVER;
  const dlg = h('dialog', { class: 'sgt-dialog', 'aria-labelledby': 'sgt-dlg-title' });
  const title = h('h2', { class: 'sgt-dlg-title', id: 'sgt-dlg-title' });
  const body = h('div', { class: 'sgt-dlg-body' });
  const actions = h('div', { class: 'sgt-dlg-actions' });
  dlg.append(title, body, actions);

  let running = false;
  dlg.addEventListener('cancel', (e) => {
    if (running) e.preventDefault();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    onCancel?.();
  });

  const close = () => dlg.close();

  /* confirm */
  title.textContent = SGT.t('modalTitle');
  const input = needsTyping
    ? h('input', {
        class: 'sgt-input',
        id: 'sgt-confirm',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-describedby': 'sgt-confirm-help',
      })
    : null;
  const go = h('button', { type: 'button', class: 'sgt-btn sgt-btn-danger' }, SGT.t('leaveN', [String(count)]));
  go.disabled = needsTyping;
  // Accept the word with or without diacritics ("OPUŚĆ" or "OPUSC"), any case.
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
  input?.addEventListener('input', () => {
    go.disabled = norm(input.value) !== norm(word);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !go.disabled) go.click();
  });

  body.append(...kids(
    h('p', null, SGT.t('modalBody', [String(count), String(pinned)])),
    h('p', { class: 'sgt-note' }, SGT.icon('warn'), h('span', null, SGT.t('modalWarn'))),
    input && h('div', { class: 'sgt-field' },
      h('label', { for: 'sgt-confirm', class: 'sgt-label' }, SGT.t('typeToConfirm', [word])),
      input,
      h('span', { id: 'sgt-confirm-help', class: 'sgt-help' }, SGT.t('typeHelp'))),
  ));
  actions.append(h('button', { type: 'button', class: 'sgt-btn', onclick: close }, SGT.t('cancel')), go);

  /* progress */
  const fill = h('div', { class: 'sgt-progress-fill' });
  const counter = h('span', { class: 'sgt-progress-count' });
  const failedEl = h('span', { class: 'sgt-progress-failed' });
  let ctrl;

  go.addEventListener('click', () => {
    running = true;
    ctrl = new AbortController();
    title.textContent = SGT.t('progress');
    body.replaceChildren(
      h('div', {
        class: 'sgt-progress',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(count),
        'aria-valuenow': '0',
      }, fill),
      h('div', { class: 'sgt-progress-meta' }, counter, failedEl),
    );
    const stop = h('button', { type: 'button', class: 'sgt-btn', onclick: () => { stop.disabled = true; ctrl.abort(); } },
      SGT.t('stop'));
    actions.replaceChildren(stop);
    api.update({ done: 0, failed: 0, total: count });
    onConfirm(ctrl.signal);
  });

  const api = {
    open() {
      document.body.append(dlg);
      dlg.showModal();
      (input || go).focus();
    },
    update({ done, failed, total }) {
      const n = done + failed;
      fill.style.transform = `scaleX(${total ? n / total : 0})`;
      body.firstChild?.setAttribute?.('aria-valuenow', String(n));
      counter.textContent = SGT.t('progressCount', [String(n), String(total)]);
      failedEl.textContent = failed ? SGT.t('failedCount', [String(failed)]) : '';
    },
    finish({ done, failed, cancelled, error }) {
      running = false;
      title.textContent = SGT.t(error ? 'errorTitle' : cancelled ? 'stoppedTitle' : 'doneTitle');
      body.replaceChildren(...kids(
        error
          ? h('p', null, error)
          : h('p', null, SGT.t('doneBody', [String(done.length)])),
        !error && failed.length ? h('p', { class: 'sgt-note' }, SGT.icon('warn'),
          h('span', null, SGT.t('doneFailed', [String(failed.length)]))) : null,
      ));
      const reload = h('button', { type: 'button', class: 'sgt-btn sgt-btn-primary', onclick: () => location.reload() },
        SGT.t('reload'));
      actions.replaceChildren(h('button', { type: 'button', class: 'sgt-btn', onclick: close }, SGT.t('close')), reload);
      reload.focus();
    },
  };
  return api;
};
