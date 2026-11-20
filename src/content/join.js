'use strict';

/**
 * Joining groups and knowing which groups the viewer is already in.
 *
 * Membership: the viewer's profile XML lists every group as a gid64 (~200 bytes per group).
 * Steam regenerates it at most hourly, so store.setMembers() overlays local joins/leaves from
 * the last hour. On the viewer's own group list the live DOM is used instead (always fresh).
 *
 * Joining posts the same form as the group page's "Join Group" button
 * (POST /groups/<x>  action=join, sessionID) and reads the header of the page Steam answers with.
 */

let membersPromise = null;

SGT.loadMembers = () => {
  if (SGT.store.members) return Promise.resolve(SGT.store.members);
  if (membersPromise) return membersPromise;
  const { steamId } = SGT.readContext();
  if (!steamId) return Promise.resolve(null);
  membersPromise = (async () => {
    try {
      const res = await SGT.fetch(SGT.url.membershipXml(steamId), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return null;
      const xml = await res.text();
      if (!/<groups>/.test(xml) && !/<profile>/.test(xml)) return null; // error page, do not cache
      const gids = [...xml.matchAll(/<groupID64>(10358279\d{10})<\/groupID64>/g)].map((m) => m[1]);
      return await SGT.store.setMembers(gids);
    } catch {
      return null;
    } finally {
      membersPromise = null;
    }
  })();
  return membersPromise;
};

/**
 * Inspect the page Steam answers a join with:
 *   'ok'      a normal group page came back (Steam keeps join_group_form in the markup even
 *             for members, so its presence says nothing)
 *   'pending' the join form now carries a non-join action (e.g. cancel a pending request)
 *   'error'   an error page instead of the group page (too many groups, session expired, ...)
 */
SGT.createJoinParser = () => {
  let buf = '';
  let found = false;
  return (chunk, final) => {
    buf += chunk;
    if (!found) {
      if (/class="(?:error_ctn|profile_fatalerror)/.test(buf)) return 'error';
      const i = buf.indexOf('grouppage_header_name');
      if (i === -1) {
        buf = buf.slice(-256);
        return final ? 'error' : undefined;
      }
      buf = buf.slice(i);
      found = true;
    }
    const end = buf.indexOf('grouppage_resp_header');
    if (end === -1 && !final && buf.length < 16384) return undefined;
    const region = end === -1 ? buf : buf.slice(0, end);
    if (region.includes('icon_inviteonly')) return 'invite';
    const action = region.match(/<form[^>]*name="join_group_form"[\s\S]*?name="action"\s+value="([^"]*)"/)?.[1];
    return action && action !== 'join' ? 'pending' : 'ok';
  };
};

/** Serialize joins so rapid clicks do not fire a burst at Steam. */
let chain = Promise.resolve();
const JOIN_GAP_MS = 700;

/**
 * Join one group. Resolves to 'joined', 'requested' (private group, waiting for approval),
 * 'invite' (membership by invitation only) or 'failed'. isPrivate: true / false / null.
 */
SGT.joinGroup = (key, { isPrivate = null } = {}) => {
  const run = async () => {
    const { sessionId } = SGT.readContext();
    if (!sessionId) return 'failed';
    try {
      const res = await SGT.fetch(SGT.url.group(key), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ action: 'join', sessionID: sessionId }),
      });
      if (res.status === 429 || !res.ok || !res.body) return 'failed';
      const state = await SGT.streamParse(res, SGT.createJoinParser());
      if (state === 'invite') return 'invite';
      if (state === 'pending') return 'requested';
      if (state === 'ok') return isPrivate ? 'requested' : 'joined';
      return 'failed';
    } catch {
      return 'failed';
    }
  };
  const p = chain.then(run);
  chain = p.then(() => SGT.sleep(JOIN_GAP_MS), () => SGT.sleep(JOIN_GAP_MS));
  return p;
};
