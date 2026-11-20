'use strict';

const DEFAULTS = { tags: true, delay: 1200, ttl: 7, lang: 'en' };
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
const t = (k, s) => sgtTranslate(settings.lang, k, s);

const save = () => chrome.storage.local.set({ s: settings });

/** (Re)paint every translated string; called on load and on language change. */
const paintText = () => {
  document.documentElement.lang = settings.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const b of document.querySelectorAll('[data-key="ttl"] button')) b.textContent = `${b.dataset.v} ${t('popupDays')}`;
  for (const id of ['clear-cache', 'clear-pins']) {
    const b = $(id);
    if (!armed.get(b)) b.textContent = t('popupClear');
  }
};

const paintSeg = (seg) => {
  const val = String(settings[seg.dataset.key]);
  for (const b of seg.querySelectorAll('button')) {
    const on = b.dataset.v === val;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
};

const paintCounts = (tags = {}, pins = []) => {
  $('cache-n').textContent = String(Object.keys(tags).length);
  $('pins-n').textContent = String(pins.length);
  $('clear-cache').disabled = !Object.keys(tags).length;
  $('clear-pins').disabled = !pins.length;
};

// Language options come from the shared dictionary.
for (const [code, label] of Object.entries(SGT_LANGS)) {
  $('lang-seg').append(Object.assign(document.createElement('button'), {
    type: 'button', textContent: label,
  }));
  const b = $('lang-seg').lastChild;
  b.setAttribute('role', 'radio');
  b.dataset.v = code;
}
$('ver').textContent = `v${chrome.runtime.getManifest().version}`;

const armed = new WeakMap();

chrome.storage.local.get(['s', 't', 'p']).then(({ s = {}, t: tags, p }) => {
  settings = { ...DEFAULTS, ...s };
  $('tags').checked = settings.tags;
  document.querySelectorAll('.seg').forEach(paintSeg);
  paintText();
  paintCounts(tags, p);
});

$('tags').addEventListener('change', (e) => {
  settings.tags = e.target.checked;
  save();
});

for (const seg of document.querySelectorAll('.seg')) {
  const pick = (b) => {
    const key = seg.dataset.key;
    settings[key] = key === 'lang' ? b.dataset.v : Number(b.dataset.v);
    paintSeg(seg);
    if (key === 'lang') paintText();
    save();
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) pick(b);
  });
  // Arrow keys move within the radio group.
  seg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const btns = [...seg.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    const next = btns[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + btns.length) % btns.length];
    next.focus();
    pick(next);
  });
}

/** Two-step clear: first click arms the button for 3 s, second click clears. */
const twoStep = (btn, fn) => btn.addEventListener('click', async () => {
  if (!armed.get(btn)) {
    armed.set(btn, setTimeout(() => {
      armed.delete(btn);
      btn.textContent = t('popupClear');
      btn.classList.remove('is-armed');
    }, 3000));
    btn.textContent = `${t('popupClear')}?`;
    btn.classList.add('is-armed');
    return;
  }
  clearTimeout(armed.get(btn));
  armed.delete(btn);
  await fn();
  btn.classList.remove('is-armed');
  btn.textContent = t('popupCleared');
});

twoStep($('clear-cache'), () => chrome.storage.local.remove('t'));
twoStep($('clear-pins'), () => chrome.storage.local.set({ p: [] }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.s?.newValue && changes.s.newValue.lang !== settings.lang) {
    settings = { ...DEFAULTS, ...changes.s.newValue };
    document.querySelectorAll('.seg').forEach(paintSeg);
    paintText();
  }
  if (changes.t || changes.p) chrome.storage.local.get(['t', 'p']).then(({ t: tags, p }) => paintCounts(tags, p));
});

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://steamcommunity.com/my/groups/' });
  window.close();
});
