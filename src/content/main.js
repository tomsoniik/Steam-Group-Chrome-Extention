'use strict';

/**
 * Lifecycle and page behaviour.
 *
 * list page:   tags, data-search augmentation (Steam's own search box finds tags), sort by tag,
 *              duplicate detection, pins + bulk leave (owner), instant join (someone else's list).
 * search page: tags, instant join, filter loaded results by tag, load more results in place.
 *
 * The friends/groups area soft-navigates (#subpage_container is swapped via ajax), so we mount
 * when the group list appears and unmount when it goes. Search results are re-rendered inside
 * the same #search_results node, which a childList observer follows.
 */
(() => {
  const A = SGT.adapter;
  const IS_SEARCH = SGT.PAGE === 'search';
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  let view = null;
  let leaving = false;

  const mount = () => {
    if (!A.ready()) return;
    const list = document.querySelector(SGT.sel.list);
    if (view?.list === list) return;
    unmount();

    const owner = SGT.isOwnerView();
    const showJoin = !owner && SGT.isLoggedIn();
    const tagsOn = SGT.store.settings.tags;

    /** row element -> { key, idx, badge, join } */
    const rowInfo = new Map();
    const failed = new Set();
    const settleHooks = new Set();
    const toRender = [];
    let renderQueued = false;
    let order = 0;
    let dupRows = new Set();
    const mode = { sort: 'default', dup: false };

    const tagOf = (info) => (info.key ? SGT.store.getTag(info.key) : undefined);

    /* ---------- tags ---------- */

    const queue = tagsOn && new SGT.TagQueue({
      concurrency: 3,
      wantGid: IS_SEARCH && showJoin,
      onResult(key, res) {
        if (res) SGT.store.setTag(key, res.tag, res.gid, res.invite);
        else failed.add(key);
        toRender.push([key, res]);
        if (!renderQueued) {
          renderQueued = true;
          requestAnimationFrame(flushRender);
        }
      },
    });

    const io = queue && new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const info = rowInfo.get(e.target);
        if (info?.key) queue.push(info.key);
      }
    }, { rootMargin: '600px 0px' });

    /** Append the tag to Steam's data-search attribute so its own filter box matches tags too. */
    const setSearchAttr = (row, tag) => {
      if (IS_SEARCH || !row.hasAttribute('data-search')) return;
      row.dataset.sgtSearch ??= row.getAttribute('data-search');
      row.setAttribute('data-search', `${row.dataset.sgtSearch} ${tag.toLowerCase()}`);
    };

    function flushRender() {
      renderQueued = false;
      const results = new Map(toRender.splice(0));
      for (const [row, info] of rowInfo) {
        if (!results.has(info.key)) continue;
        const res = results.get(info.key);
        if (info.badge) {
          SGT.ui.setBadge(info.badge, res?.tag || null);
          if (!res?.tag) info.badge = null;
        }
        if (res?.tag) setSearchAttr(row, res.tag);
        if (res?.gid && info.join && !info.join.dataset.gid) {
          info.join.dataset.gid = res.gid;
          if (SGT.store.members?.has(res.gid) && info.join.dataset.state === 'idle') {
            SGT.ui.setJoin(info.join, 'member');
          }
        }
        if (res?.invite && info.join && (info.join.dataset.state === 'idle' || info.join.dataset.state === 'failed')) {
          SGT.ui.setJoin(info.join, 'invite');
        }
      }
      for (const key of results.keys()) for (const hook of [...settleHooks]) hook(key);
      if (IS_SEARCH) applySearchFilter();
      else refreshDups();
    }

    /** Fetch every missing tag for the current rows; resolves when all have settled. */
    const ensureAll = () => {
      if (!queue) return Promise.resolve();
      const missing = new Set();
      for (const info of rowInfo.values()) {
        if (info.key && tagOf(info) === undefined && !failed.has(info.key)) missing.add(info.key);
      }
      if (!missing.size) return Promise.resolve();
      const total = missing.size;
      return new Promise((resolve) => {
        const hook = (key) => {
          if (!missing.delete(key)) return;
          bar?.setProgress(total - missing.size, total);
          if (!missing.size) {
            settleHooks.delete(hook);
            bar?.setProgress(0, 0);
            resolve();
          }
        };
        settleHooks.add(hook);
        bar?.setProgress(0, total);
        for (const k of missing) queue.push(k);
      });
    };

    /* ---------- rows ---------- */

    const joinState = (gid, key) => {
      if (gid && SGT.store.members?.has(gid)) return 'member';
      return SGT.store.invites.get(key) ? 'invite' : 'idle';
    };

    const decorate = (row) => {
      if (rowInfo.has(row)) return;
      const key = SGT.rowKey(row);
      const info = { key, idx: order++, badge: null, join: null };
      rowInfo.set(row, info);
      const link = row.querySelector(A.link);

      if (queue && key && link) {
        const cached = SGT.store.getTag(key);
        if (cached !== '') {
          info.badge = SGT.ui.badge();
          link.after(info.badge);
          if (cached) {
            SGT.ui.setBadge(info.badge, cached);
            setSearchAttr(row, cached);
          } else {
            io.observe(row);
          }
        }
      }

      if (owner) {
        const gid = SGT.rowGid(row);
        info.gid = gid;
        if (gid) {
          row.classList.add('sgt-host');
          info.side = SGT.ui.pin(gid, SGT.store.pins.has(gid));
          row.append(info.side);
        }
      } else if (showJoin && key) {
        const gid = SGT.rowGid(row) || SGT.store.gids.get(key) || '';
        info.join = SGT.ui.join(joinState(gid, key), A.isPrivate(row));
        // Tag cached by an older version: invite-only status unknown, re-read it when visible.
        if (queue && !SGT.store.invites.has(key) && SGT.store.getTag(key) !== undefined) io.observe(row);
        info.join.dataset.gid = gid;
        info.side = info.join;
        row.classList.add('sgt-host');
        row.append(info.join);
      }
      if (info.side) placeSide(row);
    };

    /**
     * Keep our right-side action clear of controls already on the row (Steam's "Leave Group",
     * checkboxes from other extensions). Batched: all layout reads first, then all writes.
     */
    const sideQueue = new Set();
    let sideFrame = 0;
    function placeSide(row) {
      sideQueue.add(row);
      sideFrame ||= requestAnimationFrame(() => {
        sideFrame = 0;
        const rows = [...sideQueue].filter((r) => r.isConnected && rowInfo.get(r)?.side);
        sideQueue.clear();
        const offsets = rows.map(SGT.sideOffset);
        rows.forEach((r, i) => { rowInfo.get(r).side.style.right = `${offsets[i]}px`; });
      });
    }
    // Other extensions often inject their row controls after us; measure once more later.
    const lateSide = setTimeout(() => { for (const r of rowInfo.keys()) placeSide(r); }, 1500);

    const forget = (row) => {
      io?.unobserve(row);
      sideQueue.delete(row);
      rowInfo.delete(row);
    };

    for (const r of list.querySelectorAll(A.row)) decorate(r);

    /* ---------- toolbars ---------- */

    let bar = null;
    let sbar = null;

    const liveRows = () => [...rowInfo.keys()].filter((r) => r.isConnected && !r.classList.contains('sgt-left'));

    const updateCounts = () => {
      if (!bar) return;
      const rows = liveRows();
      let pinned = 0;
      if (owner) for (const r of rows) if (isPinned(r)) pinned++;
      bar.setCounts({ total: rows.length, pinned, dups: dupRows.size });
    };

    /** Mark rows whose tag (case/accent-insensitive) appears more than once. */
    const refreshDups = () => {
      const groups = new Map();
      for (const row of liveRows()) {
        const tag = tagOf(rowInfo.get(row));
        if (!tag) continue;
        const n = SGT.norm(tag);
        if (!groups.has(n)) groups.set(n, []);
        groups.get(n).push(row);
      }
      dupRows = new Set();
      for (const rows of groups.values()) if (rows.length > 1) for (const r of rows) dupRows.add(r);
      for (const [row, info] of rowInfo) {
        if (!info.badge?.dataset.tag) continue;
        const others = dupRows.has(row)
          ? groups.get(SGT.norm(info.badge.dataset.tag)).filter((r) => r !== row).map(SGT.rowName)
          : null;
        SGT.ui.setDup(info.badge, others);
      }
      updateCounts();
    };

    const byIdx = (a, b) => rowInfo.get(a).idx - rowInfo.get(b).idx;
    const byTag = (a, b) => {
      const ta = tagOf(rowInfo.get(a)) || '';
      const tb = tagOf(rowInfo.get(b)) || '';
      if (!ta !== !tb) return ta ? -1 : 1;
      return collator.compare(ta, tb) || collator.compare(SGT.rowName(a), SGT.rowName(b));
    };

    /** On your own list pinned groups always come first, whatever the sort. */
    function isPinned(r) {
      return owner && SGT.store.pins.has(rowInfo.get(r)?.gid);
    }
    const pinFirst = (cmp) => (a, b) => (isPinned(b) - isPinned(a)) || cmp(a, b);
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

    /** FLIP: remember where on-screen rows were, move them, then animate from old to new spot. */
    const measureRows = (rows) => {
      const vh = innerHeight;
      const tops = new Map();
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (b.height && b.bottom > -200 && b.top < vh + 200) tops.set(r, b.top);
      }
      return tops;
    };
    const playFlip = (tops) => {
      const moved = [];
      for (const [r, top] of tops) {
        const d = top - r.getBoundingClientRect().top;
        if (Math.abs(d) < 1) continue;
        r.style.transition = 'none';
        r.style.transform = `translateY(${d}px)`;
        moved.push(r);
      }
      if (!moved.length) return;
      list.getBoundingClientRect(); // commit the inverted positions before animating
      requestAnimationFrame(() => {
        for (const r of moved) {
          r.style.transition = 'transform 420ms cubic-bezier(0.16, 1, 0.3, 1)';
          r.style.transform = '';
          r.addEventListener('transitionend', () => { r.style.transition = ''; }, { once: true });
        }
      });
    };

    /**
     * Reorder rows in one pass (DocumentFragment) and apply the duplicates filter.
     * Skips DOM moves when the order is already right. restore = Steam's original order.
     */
    const applyLayout = ({ animate = false, restore = false } = {}) => {
      const sorted = !restore && (mode.sort === 'tag' || mode.dup);
      const cmp = restore ? byIdx : pinFirst(sorted ? byTag : byIdx);
      const rows = [...rowInfo.keys()].filter((r) => r.isConnected);
      const target = [...rows].sort(cmp);
      const current = [...list.querySelectorAll(A.row)];
      if (target.some((r, i) => current[i] !== r)) {
        const tops = animate && !reduceMotion.matches ? measureRows(target) : null;
        const frag = document.createDocumentFragment();
        for (const r of target) frag.append(r);
        list.append(frag);
        if (tops) playFlip(tops);
      }
      // Steam's primary-group divider only makes sense in Steam's own order.
      const natural = target.every((r, i) => i === 0 || byIdx(target[i - 1], r) < 0);
      const pb = list.querySelector(SGT.sel.primaryBreak);
      if (pb) {
        pb.classList.toggle('sgt-hide', !natural);
        if (natural && target[0]) target[0].after(pb);
      }
      for (const r of target) {
        r.classList.toggle('sgt-hide', !restore && mode.dup && !dupRows.has(r));
        r.classList.toggle('sgt-pinned', !restore && isPinned(r));
      }
    };

    const onSort = async (v) => {
      mode.sort = v;
      bar.setSort(v);
      if (v === 'tag') await ensureAll();
      if (view?.list !== list) return;
      refreshDups();
      applyLayout();
    };

    const onDup = async () => {
      mode.dup = !mode.dup;
      bar.setDup(mode.dup);
      if (mode.dup) await ensureAll();
      if (view?.list !== list) return;
      refreshDups();
      if (mode.dup && !dupRows.size) {
        mode.dup = false;
        bar.setDup(false);
        SGT.ui.toast(SGT.t('noDups'));
      }
      applyLayout();
    };

    if (!IS_SEARCH && (owner || tagsOn)) {
      bar = SGT.ui.listBar({ owner, onSort, onDup, onLeaveAll: () => leaveAll() });
      if (!tagsOn) {
        // Sorting and duplicates need tags; with tags off only the leave action remains.
        bar.el.querySelector('.sgt-seg')?.remove();
        bar.el.querySelector('.sgt-toggle')?.remove();
      }
      bar.setSort('default');
      const titleBar = document.querySelector(SGT.sel.titleBar);
      if (titleBar) titleBar.after(bar.el);
      else list.before(bar.el);
      refreshDups();
    }
    if (owner) applyLayout();

    /* ---------- search page ---------- */

    let q = '';
    let page = 1;
    let searchText = '';
    let total = null;
    let loadingMore = false;

    const readTotal = () => {
      const txt = list.querySelector(`${SGT.sel.searchPaging} .community_searchresults_paging`)?.textContent || '';
      const nums = txt.match(/\d[\d.,  ]*/g);
      return nums ? Number(nums[nums.length - 1].replace(/\D/g, '')) || null : null;
    };

    const resetPaging = () => {
      page = Number(new URLSearchParams(location.hash.slice(1)).get('page')) || 1;
      searchText = document.querySelector(SGT.sel.searchBox)?.value.trim() || '';
      total = readTotal();
      sbar?.setMore(!rowInfo.size || !searchText ? 'hidden' : total && rowInfo.size >= total ? 'end' : 'idle');
    };

    function applySearchFilter() {
      if (!sbar) return;
      const nq = SGT.norm(q);
      let shown = 0;
      for (const [row, info] of rowInfo) {
        const tag = tagOf(info);
        let hide = false;
        let pending = false;
        if (nq) {
          if (tag === undefined && info.key && !failed.has(info.key)) pending = true;
          else hide = !(tag && SGT.norm(tag).includes(nq));
        }
        row.classList.toggle('sgt-hide', hide);
        row.classList.toggle('sgt-pending', pending);
        if (!hide) shown++;
      }
      sbar.setCount(nq
        ? SGT.t('matchCount', [String(shown), String(rowInfo.size)])
        : SGT.t('loadedCount', [String(rowInfo.size), total ? total.toLocaleString() : '?']));
    }

    /** Strip anything executable from Steam-rendered result markup before adopting it. */
    const sanitize = (root) => {
      for (const s of root.querySelectorAll('script, iframe, object, embed')) s.remove();
      for (const el of root.querySelectorAll('*')) {
        for (const { name, value } of [...el.attributes]) {
          if (name.startsWith('on') || /^\s*javascript:/i.test(value)) el.removeAttribute(name);
        }
      }
      return root;
    };

    const onMore = async () => {
      if (loadingMore || !searchText) return;
      loadingMore = true;
      sbar.setMore('busy');
      try {
        const ctx = SGT.readContext();
        const res = await SGT.fetch(SGT.url.search({ text: searchText, page: page + 1, ...ctx }), { credentials: 'include' });
        const data = res.ok ? await res.json() : null;
        if (data?.success !== 1) throw new Error('search');
        const doc = new DOMParser().parseFromString(data.html, 'text/html');
        const rows = [...doc.querySelectorAll('.search_row.group')];
        if (!rows.length) {
          sbar.setMore('end');
          return;
        }
        const frag = document.createDocumentFragment();
        for (const r of rows) frag.append(document.importNode(sanitize(r), true));
        const pagers = list.querySelectorAll(SGT.sel.searchPaging);
        const anchor = pagers.length > 1 ? pagers[pagers.length - 1] : null;
        if (anchor) anchor.before(frag);
        else list.append(frag);
        page++;
        sbar.setMore(total && rowInfo.size >= total ? 'end' : 'idle');
      } catch {
        SGT.ui.toast(SGT.t('loadFailed'), 'warn');
        sbar.setMore('idle');
      } finally {
        loadingMore = false;
      }
    };

    if (IS_SEARCH && tagsOn) {
      sbar = SGT.ui.searchBar({
        onFilter(v) {
          q = v;
          if (SGT.norm(q)) ensureAll();
          applySearchFilter();
        },
        onMore,
      });
      list.before(sbar.el);
      resetPaging();
      applySearchFilter();
    }

    /* ---------- observers + events ---------- */

    const mo = new MutationObserver((muts) => {
      let rerendered = false;
      for (const m of muts) {
        for (const n of m.removedNodes) {
          // Rows moved by applyLayout are connected again by now; only drop real removals.
          if (n.nodeType === 1 && !n.isConnected && rowInfo.has(n)) {
            forget(n);
            rerendered = true;
          }
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.matches(A.row)) decorate(n);
          else if (n.nodeType === 1 && n.matches?.(SGT.sel.searchPaging)) rerendered = true;
        }
      }
      if (IS_SEARCH) {
        if (rerendered) resetPaging();
        applySearchFilter();
      } else {
        refreshDups();
      }
    });
    mo.observe(list, { childList: true });

    const onJoin = async (btn, row) => {
      const info = rowInfo.get(row);
      if (!info?.key) return;
      const gid = btn.dataset.gid || SGT.store.gids.get(info.key) || null;
      SGT.ui.setJoin(btn, 'busy');
      const result = await SGT.joinGroup(info.key, { isPrivate: A.isPrivate(row) });
      const name = SGT.rowName(row);
      if (result === 'joined') {
        SGT.ui.setJoin(btn, 'member');
        SGT.store.addMember(gid);
        SGT.ui.toast(SGT.t('joinedToast', [name]));
      } else if (result === 'invite') {
        SGT.ui.setJoin(btn, 'invite');
        SGT.store.setInvite(info.key, true);
        SGT.ui.toast(SGT.t('inviteToast', [name]), 'lock');
      } else if (result === 'requested') {
        SGT.ui.setJoin(btn, 'requested');
        SGT.ui.toast(SGT.t('requestedToast', [name]), 'clock');
      } else {
        SGT.ui.setJoin(btn, 'failed');
        SGT.ui.toast(SGT.t('joinFailed'), 'warn');
      }
    };

    // One delegated listener for badges, pins and join buttons.
    const onClick = (e) => {
      const target = e.target.closest('.sgt-pin, .sgt-join, .sgt-tag[data-tag]');
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      if (target.classList.contains('sgt-pin')) {
        SGT.ui.setPin(target, SGT.store.togglePin(target.dataset.gid));
        updateCounts();
        applyLayout({ animate: true });
      } else if (target.classList.contains('sgt-join')) {
        if (!target.disabled) onJoin(target, target.closest(A.row));
      } else {
        navigator.clipboard.writeText(target.dataset.tag).then(
          () => SGT.ui.toast(SGT.t('copied', [target.dataset.tag])),
          () => {},
        );
      }
    };
    const onKey = (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.sgt-tag[data-tag]')) {
        e.preventDefault();
        e.target.click();
      }
    };
    list.addEventListener('click', onClick, true);
    list.addEventListener('keydown', onKey);

    /* ---------- membership ---------- */

    if (owner && SGT.isLoggedIn()) {
      SGT.store.setMembers([...rowInfo.keys()].map(SGT.rowGid).filter(Boolean), { fresh: true });
    } else if (showJoin) {
      SGT.loadMembers().then((members) => {
        if (!members || view?.list !== list) return;
        for (const info of rowInfo.values()) {
          if (info.join?.dataset.state === 'idle' && members.has(info.join.dataset.gid)) {
            SGT.ui.setJoin(info.join, 'member');
          }
        }
      });
    }

    /* ---------- bulk leave (owner) ---------- */

    const leaveAll = () => {
      if (leaving) return;
      const targets = [];
      let pinned = 0;
      for (const r of liveRows()) {
        const gid = SGT.rowGid(r);
        if (!gid) continue;
        if (SGT.store.pins.has(gid)) pinned++;
        else targets.push([gid, r]);
      }
      if (!targets.length) {
        SGT.ui.toast(SGT.t('nothingToLeave'));
        return;
      }
      const byGid = new Map(targets);
      const warnUnload = (e) => {
        e.preventDefault();
        e.returnValue = '';
      };

      const dlg = SGT.ui.leaveDialog({
        count: targets.length,
        pinned,
        onConfirm: async (signal) => {
          leaving = true;
          addEventListener('beforeunload', warnUnload);
          let result;
          try {
            result = await SGT.leaveGroups([...byGid.keys()], {
              delay: SGT.store.settings.delay,
              signal,
              onProgress(p) {
                if (p.ok) for (const g of p.batch) byGid.get(g)?.classList.add('sgt-left');
                dlg.update(p);
              },
            });
            SGT.store.removeMembers(result.done);
          } catch (err) {
            result = { done: [], failed: [], cancelled: false, error: err.message };
          } finally {
            leaving = false;
            removeEventListener('beforeunload', warnUnload);
          }
          refreshDups();
          dlg.finish(result);
        },
      });
      dlg.open();
    };

    view = {
      list,
      refreshPins() {
        for (const b of list.querySelectorAll('.sgt-pin')) SGT.ui.setPin(b, SGT.store.pins.has(b.dataset.gid));
        updateCounts();
        applyLayout({ animate: true });
      },
      destroy() {
        queue?.destroy();
        clearTimeout(lateSide);
        cancelAnimationFrame(sideFrame);
        io?.disconnect();
        mo.disconnect();
        list.removeEventListener('click', onClick, true);
        list.removeEventListener('keydown', onKey);
        bar?.el.remove();
        sbar?.el.remove();
        mode.sort = 'default';
        mode.dup = false;
        applyLayout({ restore: true });
        for (const el of list.querySelectorAll('.sgt-tag, .sgt-pin, .sgt-join')) el.remove();
        for (const row of rowInfo.keys()) {
          row.classList.remove('sgt-host', 'sgt-hide', 'sgt-pending');
          if (row.dataset.sgtSearch != null) {
            row.setAttribute('data-search', row.dataset.sgtSearch);
            delete row.dataset.sgtSearch;
          }
        }
        rowInfo.clear();
        settleHooks.clear();
      },
    };
  };

  const unmount = () => {
    if (!view) return;
    view.destroy();
    view = null;
    SGT.store.flush().catch(() => {});
  };

  // Settings, pins or cache changed from the popup or another tab.
  SGT.onStoreChange = (changes) => {
    SGT.dock.onChange(changes);
    if (leaving || !view) return;
    if (changes.s || (changes.t && !changes.t.newValue)) {
      unmount();
      mount();
    } else if (changes.p) {
      view.refreshPins();
    }
  };

  const start = async () => {
    await SGT.store.load();
    SGT.dock.mount();
    mount();
    const sub = document.querySelector(SGT.sel.subpage);
    if (sub && !IS_SEARCH) {
      new MutationObserver(() => (document.getElementById('groups_list') ? mount() : unmount()))
        .observe(sub, { childList: true });
    }
    addEventListener('pagehide', unmount);
    addEventListener('pageshow', (e) => {
      if (e.persisted) mount();
    });
  };

  start().catch(() => {});
})();
