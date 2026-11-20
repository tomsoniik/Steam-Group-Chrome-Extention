'use strict';

/**
 * Everything that depends on Steam's markup or endpoints lives here.
 * If Valve changes the page, this is the only file that should need edits.
 */
const SGT = {};

SGT.ORIGIN = 'https://steamcommunity.com';

SGT.sel = {
  subpage: '#subpage_container',
  list: '#search_results',
  titleBar: '.profile_groups.title_bar',
  primaryBreak: '#primaryGroupBreak',
  searchPaging: '#community_searchresults_pagination',
  searchBox: '#search_text_box',
};

/**
 * Two kinds of pages carry group rows:
 *   list   = /id|profiles/<x>/groups  (someone's group list, or your own with manage controls)
 *   search = /search/groups            (Steam community search, rows injected via ajax)
 */
SGT.PAGE = location.pathname.startsWith('/search/groups') ? 'search' : 'list';

const PRIVATE_RE = /privat|prywat|privé|privad|priva|приват|soukrom|súkrom|yksityi|ιδιωτ|özel|riêng|ส่วนตัว|非公開|私人|私密|비공개/i;
const PUBLIC_RE = /public|publi|öffentlich|offentlig|openbar|публич|veřejn|verejn|julkinen|δημόσ|herkese|nyilvános|công khai|สาธารณะ|公開|公开|공개/i;

SGT.adapter = SGT.PAGE === 'search'
  ? {
      row: '#search_results > .search_row.group',
      link: 'a.searchPersonaName',
      ready: () => !!document.querySelector(SGT.sel.list),
      // Search rows only carry a localized label ("- Public group", "- Grupa prywatna", ...).
      // Match the word in common Steam languages; anything else stays unknown (null).
      isPrivate: (row) => {
        const txt = row.querySelector('.search_group_type')?.textContent || '';
        if (PRIVATE_RE.test(txt)) return true;
        if (PUBLIC_RE.test(txt)) return false;
        return null;
      },
    }
  : {
      row: '#search_results > .group_block',
      link: 'a.linkTitle',
      ready: () => !!document.getElementById('groups_list') && !!document.querySelector(SGT.sel.list),
      isPrivate: (row) => !row.querySelector('.pubGroup'),
    };

/** Firefox content scripts need content.fetch to send requests as the page (cookies, same-origin). */
SGT.fetch = (typeof content !== 'undefined' && content && typeof content.fetch === 'function')
  ? content.fetch.bind(content)
  : fetch.bind(globalThis);

/** UI language is a setting (default English); see src/shared/i18n.js. */
SGT.t = (key, subs) => sgtTranslate(SGT.store?.settings.lang || 'en', key, subs);

/**
 * Stable cache key for a row. Uses the group URL path ("groups/esl" or "gid/1035...").
 * Lowercased because Steam vanity URLs are case-insensitive.
 */
SGT.rowKey = (row) => {
  const a = row.querySelector(SGT.adapter.link);
  if (!a) return null;
  try {
    const u = new URL(a.href, SGT.ORIGIN);
    if (u.origin !== SGT.ORIGIN) return null;
    const m = u.pathname.match(/^\/(groups|gid)\/([^/]+)/i);
    return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
  } catch {
    return null;
  }
};

const GID_RE = /^10358279\d{10}$/;

/** gid64 from the owner view's data-steamid. Only the owner's own rows carry it. */
SGT.rowOwnerGid = (row) => {
  const v = row.getAttribute('data-steamid');
  return v && GID_RE.test(v) ? v : null;
};

/** gid64 from anything we can see: owner attribute, the group-chat link, or the URL itself. */
SGT.rowGid = (row) => {
  const own = SGT.rowOwnerGid(row);
  if (own) return own;
  const chat = row.querySelector('a[href*="OpenGroupChat"]')?.getAttribute('href')
    .match(/OpenGroupChat\(\s*'(\d+)'/)?.[1];
  if (chat && GID_RE.test(chat)) return chat;
  const key = SGT.rowKey(row);
  if (key?.startsWith('gid/') && GID_RE.test(key.slice(4))) return key.slice(4);
  return null;
};

SGT.rowName = (row) => row.querySelector(SGT.adapter.link)?.textContent.trim() || '';

/**
 * Page globals (g_sessionID, g_steamID, g_rgProfileData.url) are not reachable from the
 * isolated world, so read them from inline scripts. Cached after the first successful read.
 */
let ctxCache = null;
SGT.readContext = () => {
  if (ctxCache) return ctxCache;
  let sessionId = null;
  let steamId = null;
  let profileUrl = null;
  let profileSteamId = null;
  for (const s of document.scripts) {
    if (s.src) continue;
    const txt = s.textContent;
    if (!txt || txt.length > 200000) continue;
    if (!sessionId) sessionId = txt.match(/g_sessionID\s*=\s*"([0-9a-f]{16,32})"/i)?.[1] || null;
    if (!steamId) steamId = txt.match(/g_steamID\s*=\s*"(\d{17})"/)?.[1] || null;
    if (!profileUrl) {
      const at = txt.search(/g_rgProfileData\s*=\s*\{/);
      if (at !== -1) {
        const head = txt.slice(at, at + 600); // url and steamid come first, before personaname
        const raw = head.match(/"url":"([^"]+)"/)?.[1];
        if (raw) profileUrl = raw.replace(/\\\//g, '/');
        profileSteamId = head.match(/"steamid":"(\d{17})"/)?.[1] || null;
      }
    }
    if (sessionId && steamId && profileUrl) break;
  }
  if (!sessionId) {
    sessionId = document.cookie.match(/(?:^|;\s*)sessionid=([0-9a-f]{16,32})/i)?.[1] || null;
  }
  if (profileUrl) {
    try {
      const u = new URL(profileUrl);
      if (u.origin !== SGT.ORIGIN) profileUrl = null;
      else if (!profileUrl.endsWith('/')) profileUrl += '/';
    } catch {
      profileUrl = null;
    }
  }
  const ctx = { sessionId, steamId, profileUrl, profileSteamId };
  if (sessionId) ctxCache = ctx;
  return ctx;
};

/** Logged in = Steam printed the viewer's SteamID into the page. */
SGT.isLoggedIn = () => !!SGT.readContext().steamId;

/**
 * Owner view = the logged-in viewer is looking at their own group list.
 * Compares the viewer's SteamID with the profile's; row attributes differ between Steam
 * versions (and other extensions add their own controls), so markup is not a reliable signal.
 */
SGT.isOwnerView = () => {
  if (SGT.PAGE !== 'list') return false;
  const { steamId, profileSteamId } = SGT.readContext();
  if (steamId && profileSteamId) return steamId === profileSteamId;
  return !!document.querySelector(`${SGT.adapter.row}[data-steamid]`);
};

/**
 * Right offset for our row action so it sits left of whatever Steam (or another extension)
 * already put on the right edge of the row: "Leave Group" buttons, checkboxes, ...
 * One layout read per row; returns pixels from the row's right edge.
 */
SGT.sideOffset = (row) => {
  const box = row.getBoundingClientRect();
  if (!box.width) return 16;
  let minLeft = box.right;
  for (const el of row.querySelectorAll('a, button, input, label, select, [role="button"]')) {
    if (el.closest('.sgt-side, .sgt-tag')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.left < box.left + box.width * 0.55) continue;
    if (r.left < minLeft) minLeft = r.left;
  }
  return minLeft < box.right ? Math.round(box.right - minLeft + 10) : 16;
};

SGT.url = {
  group: (key) => `${SGT.ORIGIN}/${key}`,
  membershipXml: (steamId) => `${SGT.ORIGIN}/profiles/${steamId}/?xml=1`,
  search: ({ text, page, sessionId, steamId }) => `${SGT.ORIGIN}/search/SearchCommunityAjax?${new URLSearchParams({
    text, filter: 'groups', sessionid: sessionId, steamid_user: steamId || 'false', page: String(page),
  })}`,
};

SGT.sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(id);
    reject(signal.reason);
  }, { once: true });
});

/** Case- and accent-insensitive form used for duplicate detection and tag filtering. */
SGT.norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
