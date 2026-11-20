'use strict';

/**
 * Compact persistent state in chrome.storage.local:
 *   t: { [rowKey]: [tag, savedAtSeconds, gid64|0, inviteOnly 1|0] }   tag cache
 *   p: [gid64, ...]                                   pinned (never leave)
 *   m: { at, g: [gid64, ...], r: { gid64: [1|0, at] } } groups the viewer is in + recent changes
 *   s: { tags, delay, ttl, lang }                     settings
 *   d: { c: collapsed }                               dock state (kept apart so it never rebuilds the page view)
 * Loaded once per page, written back debounced.
 */
SGT.DEFAULTS = Object.freeze({ tags: true, delay: 1200, ttl: 7, lang: 'en' });
const EMPTY_TTL_S = 86400; // groups without a tag are re-checked after 1 day
const MEMBERS_TTL_S = 1800;
const now = () => Math.floor(Date.now() / 1000);

SGT.store = {
  tags: new Map(),
  gids: new Map(),
  invites: new Map(), // key -> true/false once known (older cache entries: unknown)
  pins: new Set(),
  members: null, // Set<gid64> once known
  settings: { ...SGT.DEFAULTS },
  _pending: null,
  _timer: 0,

  async load() {
    const { t = {}, p = [], s = {}, m } = await chrome.storage.local.get(['t', 'p', 's', 'm']);
    this.settings = { ...SGT.DEFAULTS, ...s };
    this.pins = new Set(p);
    if (m && now() - m.at < MEMBERS_TTL_S) {
      this.members = new Set(m.g);
      this._overlay = m.r || {};
    }
    const ttl = this.settings.ttl * 86400;
    let pruned = false;
    for (const k in t) {
      const [tag, at, gid, invite] = t[k];
      if (now() - at < (tag ? ttl : EMPTY_TTL_S)) {
        this.tags.set(k, tag);
        if (gid) this.gids.set(k, gid);
        if (invite !== undefined) this.invites.set(k, invite === 1);
      } else {
        pruned = true;
      }
    }
    if (pruned) this._schedule();
  },

  getTag(key) {
    return this.tags.get(key);
  },

  setTag(key, tag, gid, invite = false) {
    this.tags.set(key, tag);
    if (gid) this.gids.set(key, gid);
    this.invites.set(key, invite);
    this._pending ??= {};
    this._pending[key] = [tag, now(), gid || this.gids.get(key) || 0, invite ? 1 : 0];
    this._schedule();
  },

  setInvite(key, invite) {
    if (!key || this.tags.get(key) === undefined) return;
    this.setTag(key, this.tags.get(key), null, invite);
  },

  togglePin(gid) {
    if (this.pins.has(gid)) this.pins.delete(gid);
    else this.pins.add(gid);
    chrome.storage.local.set({ p: [...this.pins] });
    return this.pins.has(gid);
  },

  /**
   * Membership. Steam regenerates the profile XML at most hourly, so a fresh XML can still miss
   * a group joined (or list one left) in the last hour. Local changes are kept in an overlay
   * `r: { gid: [1 = joined | 0 = left, at] }` for one hour and re-applied on top of XML data.
   * fresh=true means the list came from the live DOM (own group page): the overlay is reset.
   */
  async setMembers(gids, { fresh = false } = {}) {
    const { m } = await chrome.storage.local.get('m');
    const overlay = {};
    if (!fresh && m?.r) {
      for (const g in m.r) if (now() - m.r[g][1] < 3600) overlay[g] = m.r[g];
    }
    const set = new Set(gids);
    for (const g in overlay) {
      if (overlay[g][0]) set.add(g);
      else set.delete(g);
    }
    this.members = set;
    this._overlay = overlay;
    await chrome.storage.local.set({ m: { at: now(), g: [...set], r: overlay } });
    return set;
  },

  _recordMembership(gids, joined) {
    if (!this.members) this.members = new Set();
    this._overlay ??= {};
    for (const g of gids) {
      if (!g) continue;
      if (joined) this.members.add(g);
      else this.members.delete(g);
      this._overlay[g] = [joined ? 1 : 0, now()];
    }
    chrome.storage.local.set({ m: { at: now(), g: [...this.members], r: this._overlay } });
  },

  addMember(gid) {
    this._recordMembership([gid], true);
  },

  removeMembers(gids) {
    this._recordMembership(gids, false);
  },

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 1500);
  },

  /** Merge pending entries into the stored object so concurrent tabs do not clobber each other. */
  async flush() {
    clearTimeout(this._timer);
    const pending = this._pending;
    this._pending = null;
    const { t = {} } = await chrome.storage.local.get('t');
    const ttl = this.settings.ttl * 86400;
    for (const k in t) {
      const [tag, at] = t[k];
      if (now() - at >= (tag ? ttl : EMPTY_TTL_S)) delete t[k];
    }
    if (pending) Object.assign(t, pending);
    await chrome.storage.local.set({ t });
  },
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.s) SGT.store.settings = { ...SGT.DEFAULTS, ...changes.s.newValue };
  if (changes.p) SGT.store.pins = new Set(changes.p.newValue || []);
  if (changes.t && !changes.t.newValue) {
    SGT.store.tags.clear();
    SGT.store.gids.clear();
    SGT.store.invites.clear();
  }
  SGT.onStoreChange?.(changes);
});
