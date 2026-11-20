'use strict';

/**
 * Bulk leave, using the same endpoint Steam's own "Leave selected" button calls:
 *   POST {profileUrl}friends/action  sessionid, steamid, ajax=1, action=leave_group, steamids[]
 * Sent in small batches with a pause between them, so progress is visible and it can be cancelled.
 */
const BATCH = 10;

SGT.leaveGroups = async (gids, { delay, signal, onProgress }) => {
  const ctx = SGT.readContext();
  if (!ctx.sessionId || !ctx.steamId || !ctx.profileUrl) {
    throw new Error(SGT.t('errNoSession'));
  }

  const done = [];
  const failed = [];
  let retries = 0;

  for (let i = 0; i < gids.length;) {
    if (signal.aborted) break;
    const batch = gids.slice(i, i + BATCH);
    const body = new URLSearchParams({
      sessionid: ctx.sessionId,
      steamid: ctx.steamId,
      ajax: '1',
      action: 'leave_group',
    });
    for (const g of batch) body.append('steamids[]', g);

    let ok = false;
    try {
      const res = await SGT.fetch(`${ctx.profileUrl}friends/action`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
        signal,
      });
      if (res.status === 429 && retries < 4) {
        retries++;
        await SGT.sleep(delay * 2 ** (retries + 1), signal);
        continue;
      }
      const data = res.ok ? await res.json().catch(() => null) : null;
      ok = data?.success === 1;
    } catch (err) {
      if (signal.aborted) break;
    }

    retries = 0;
    (ok ? done : failed).push(...batch);
    i += batch.length;
    onProgress({ done: done.length, failed: failed.length, total: gids.length, batch, ok });
    if (i < gids.length) {
      try {
        await SGT.sleep(delay, signal);
      } catch {
        break;
      }
    }
  }

  return { done, failed, cancelled: signal.aborted };
};
