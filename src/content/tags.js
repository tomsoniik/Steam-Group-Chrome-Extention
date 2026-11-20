'use strict';

/**
 * Group page parsing.
 * The tag sits in the page header (~37 KB into a ~80 KB page). The response is read as a
 * stream and cancelled as soon as we have what we need, so the rest is never downloaded.
 */
const HEADER_MARK = 'grouppage_header_name';
const ABBREV_RE = /class="grouppage_header_abbrev"[^>]*>([^<]*)</;
const GID_IN_PAGE_RE = /(?:Clan_|OpenGroupChat\(\s*')(10358279\d{10})/;
const MAX_BYTES = 160 * 1024;
const TAIL = 64;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ' };

SGT.decodeEntities = (s) => s.replace(/&(?:amp|lt|gt|quot|nbsp|#0?39);/g, (m) => ENTITIES[m]);

/**
 * Read a fetch Response as text chunks and feed them to `parse` until it returns a value.
 * The body is cancelled right after, so unread bytes never cross the network.
 */
SGT.streamParse = async (res, parse, maxBytes = MAX_BYTES) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return parse(decoder.decode(), true);
      bytes += value.byteLength;
      const out = parse(decoder.decode(value, { stream: true }), false);
      if (out !== undefined) return out;
      if (bytes > maxBytes) return parse('', true);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
};

/**
 * Incremental group-page parser. Returns undefined while undecided, then { tag, gid, invite }.
 *   tag     '' when the group has none
 *   invite  membership by invitation only (join area shows icon_inviteonly.png, ~700 bytes
 *           after the tag, so it costs nothing extra)
 *   gid     only searched for when wantGid is set (search results do not expose it;
 *           it sits ~14 KB after the header)
 * Memory stays bounded: outside the region of interest only a short tail is kept.
 */
const JOIN_AREA_END = 'grouppage_resp_header';
SGT.createTagParser = (wantGid = false) => {
  let buf = '';
  let state = 0; // 0 = find header, 1 = read tag, 2 = read join area, 3 = find gid
  let tag = '';
  let invite = false;
  const done = (gid = null) => ({ tag, gid, invite });
  return (chunk, final = false) => {
    buf += chunk;
    if (state === 0) {
      const i = buf.indexOf(HEADER_MARK);
      if (i === -1) {
        buf = buf.slice(-TAIL);
        return final ? done() : undefined;
      }
      buf = buf.slice(i);
      state = 1;
    }
    if (state === 1) {
      const end = buf.indexOf('</div>');
      if (end === -1) {
        if (buf.length > 8192 || final) return done(); // malformed header
        return undefined;
      }
      const m = buf.slice(0, end).match(ABBREV_RE);
      tag = m ? SGT.decodeEntities(m[1]).trim() : '';
      buf = buf.slice(end);
      state = 2;
    }
    if (state === 2) {
      const end = buf.indexOf(JOIN_AREA_END);
      if (end === -1 && !final && buf.length < 16384) return undefined;
      invite = (end === -1 ? buf : buf.slice(0, end)).includes('icon_inviteonly');
      if (!wantGid) return done();
      buf = end === -1 ? buf.slice(-TAIL) : buf.slice(end);
      state = 3;
    }
    const g = buf.match(GID_IN_PAGE_RE);
    if (g) return done(g[1]);
    buf = buf.slice(-TAIL);
    return final ? done() : undefined;
  };
};

class RateLimited extends Error {}
SGT.RateLimited = RateLimited;

/** Fetch one group page and resolve with { tag, gid }. Throws on network / 429. */
SGT.fetchTag = async (key, signal, wantGid = false) => {
  const res = await SGT.fetch(SGT.url.group(key), {
    signal,
    credentials: 'include',
    headers: { Accept: 'text/html' },
  });
  if (res.status === 429) throw new RateLimited('429');
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  return SGT.streamParse(res, SGT.createTagParser(wantGid));
};

/**
 * Small work queue: max N in flight, de-duplicated by key,
 * global pause with exponential backoff on 429.
 */
SGT.TagQueue = class {
  constructor({ concurrency = 3, wantGid = false, onResult }) {
    this.concurrency = concurrency;
    this.wantGid = wantGid;
    this.onResult = onResult;
    this.waiting = [];
    this.known = new Set();
    this.active = 0;
    this.backoff = 0;
    this.pausedUntil = 0;
    this.ctrl = new AbortController();
  }

  push(key) {
    if (this.known.has(key)) return;
    this.known.add(key);
    this.waiting.push(key);
    this._pump();
  }

  destroy() {
    this.ctrl.abort();
    clearTimeout(this._resume);
    this.waiting.length = 0;
  }

  _pump() {
    if (this.ctrl.signal.aborted) return;
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) {
      clearTimeout(this._resume);
      this._resume = setTimeout(() => this._pump(), wait);
      return;
    }
    while (this.active < this.concurrency && this.waiting.length) {
      this._run(this.waiting.shift());
    }
  }

  async _run(key) {
    this.active++;
    try {
      const res = await SGT.fetchTag(key, this.ctrl.signal, this.wantGid);
      this.backoff = 0;
      this.onResult(key, res);
    } catch (err) {
      if (this.ctrl.signal.aborted) return;
      if (err instanceof RateLimited) {
        this.backoff = Math.min(this.backoff ? this.backoff * 2 : 4000, 60000);
        this.pausedUntil = Date.now() + this.backoff;
        this.waiting.unshift(key);
      } else {
        this.known.delete(key);
        this.onResult(key, null);
      }
    } finally {
      this.active--;
      this._pump();
    }
  }
};
