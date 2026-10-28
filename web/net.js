// Deathmatch over the artifact `room` capability.
//
// Each browser runs its own single-player Doom. Every tic we publish our
// player's absolute state as room presence; everyone else shows up locally as
// a ghost marine. Presence keeps only the latest value and may coalesce
// updates, so anything that must not get lost (hits, kills) travels as
// short rings / counters inside that same presence object.

const PROTOCOL = 1;
const MAX_GHOSTS = 16;
const HIT_RING = 16;
const INTERP_DELAY_MS = 100;
const SNAP_DIST = 256 * 65536; // teleports and respawns: jump, don't glide

export function startNet({ doom, room, nick = "", color = 3, onScore, onFeed, onTags }) {
  const ex = doom.exports;
  const buf = ex.dg_malloc(64);
  const read16 = () => Array.from(new Int32Array(doom.memory().buffer, buf, 16));

  let myPeer = null;
  const others = new Map(); // peer -> remote state
  const slotPeer = new Array(MAX_GHOSTS).fill(null);

  // What we publish.
  let hitSeq = 0;
  const hitRing = [];
  const killedBy = {}; // peer -> times that peer killed us
  let suicides = 0;
  let lastDeaths = 0;

  function slotFor(peer) {
    const r = others.get(peer);
    if (r.slot >= 0) return r.slot;
    const free = slotPeer.indexOf(null);
    if (free < 0) return -1;
    slotPeer[free] = peer;
    r.slot = free;
    return free;
  }

  function release(peer) {
    const r = others.get(peer);
    if (r && r.slot >= 0) {
      ex.net_ghost_remove(r.slot);
      slotPeer[r.slot] = null;
    }
    others.delete(peer);
  }

  function onPresence(peer) {
    const p = peer.presence;
    if (!p || p.v !== PROTOCOL || typeof p.x !== "number") return;
    let r = others.get(peer.peer);
    if (!r) {
      r = { slot: -1, samples: [], fire: p.f | 0, seenHit: 0, killedBy: { ...(p.kb || {}) }, suicides: p.s | 0, by: peer.by };
      // Hits sent before we arrived were for someone else's game state.
      for (const h of p.h || []) if (h[1] > r.seenHit) r.seenHit = h[1];
      others.set(peer.peer, r);
    }
    r.p = p;
    r.by = peer.by;
    const now = performance.now();
    const last = r.samples[r.samples.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) > SNAP_DIST) r.samples.length = 0;
    r.samples.push({ t: now, x: p.x, y: p.y, z: p.z, a: p.a >>> 0 });
    if (r.samples.length > 8) r.samples.shift();
  }

  // Room wiring. Presence of every peer arrives through onPeers.
  const unsubPeers = room.onPeers((change) => {
    for (const peer of change.peers) if (peer.sameTab) myPeer = peer.peer;
    for (const peer of [...change.joined, ...change.updated]) {
      if (peer.sameTab) continue;
      onPresence(peer);
    }
    for (const peer of change.left) release(peer.peer);
  });

  function sampleAt(r, t) {
    const s = r.samples;
    if (!s.length) return null;
    if (t <= s[0].t || s.length === 1) return s[0];
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1], b = s[i];
      if (t >= a.t) {
        if (t >= b.t) return b; // no newer data yet: hold the last pose
        const k = (t - a.t) / (b.t - a.t);
        const da = ((b.a - a.a + 2 ** 31) >>> 0) - 2 ** 31; // shortest turn
        return {
          x: Math.round(a.x + (b.x - a.x) * k),
          y: Math.round(a.y + (b.y - a.y) * k),
          z: Math.round(a.z + (b.z - a.z) * k),
          a: (a.a + Math.round(da * k)) >>> 0,
        };
      }
    }
    return s[s.length - 1];
  }

  // Runs right after every Doom tic.
  function tick() {
    ex.net_after_tick();
    ex.net_local(buf);
    const L = read16();
    const inLevel = L[10] === 1;
    const map = L[11];
    const now = performance.now();

    // 1. Our deaths, credited to whoever's ghost hurt us last.
    if (L[12] !== lastDeaths) {
      lastDeaths = L[12];
      const killer = L[13] >= 0 ? slotPeer[L[13]] : null;
      if (killer) killedBy[killer] = (killedBy[killer] || 0) + 1;
      else suicides++;
      onFeed && onFeed({ killer, victim: myPeer });
    }

    // 2. Damage we dealt to ghosts since the last tic.
    ex.net_take_hits(buf);
    const dealt = read16();
    for (let s = 0; s < MAX_GHOSTS; s++) {
      if (dealt[s] > 0 && slotPeer[s]) {
        hitRing.push([slotPeer[s], ++hitSeq, dealt[s]]);
        if (hitRing.length > HIT_RING) hitRing.shift();
      }
    }

    // 3. Everyone else: move ghosts, replay trigger pulls, take their hits.
    let frags = -suicides;
    for (const [peer, r] of others) {
      const p = r.p;
      for (const h of p.h || []) {
        if (h[0] === myPeer && h[1] > r.seenHit) {
          r.seenHit = h[1];
          const slot = r.slot >= 0 ? r.slot : slotFor(peer);
          ex.net_damage(slot, Math.min(h[2] | 0, 1000));
        }
      }
      const kills = (p.kb && p.kb[myPeer]) | 0;
      frags += kills;

      // Kill feed: someone else's death counter moved.
      for (const [killer, n] of Object.entries(p.kb || {})) {
        if ((r.killedBy[killer] | 0) < n) onFeed && onFeed({ killer, victim: peer });
      }
      if ((p.s | 0) > (r.suicides | 0)) onFeed && onFeed({ killer: null, victim: peer });
      r.suicides = p.s | 0;
      r.killedBy = { ...(p.kb || {}) };

      if (!inLevel || p.map !== map) {
        if (r.slot >= 0) { ex.net_ghost_remove(r.slot); slotPeer[r.slot] = null; r.slot = -1; }
        continue;
      }
      const slot = slotFor(peer);
      if (slot < 0) continue;
      const pose = sampleAt(r, now - INTERP_DELAY_MS);
      if (pose) ex.net_ghost_update(slot, pose.x, pose.y, pose.z, pose.a | 0, p.d ? 1 : 0, p.m ? 1 : 0, p.c & 3);
      const fired = ((p.f | 0) - r.fire) | 0;
      if (fired > 0) for (let i = 0; i < Math.min(fired, 3); i++) ex.net_ghost_fire(slot, p.w | 0);
      r.fire = p.f | 0;
    }
    ex.net_set_frags(frags);

    // Name tags: where each visible ghost's head is on the 320x200 screen.
    if (onTags) {
      const tags = [];
      for (const [peer, r] of others) {
        if (r.slot < 0) continue;
        ex.net_ghost_screen(r.slot, buf);
        const [x, y, visible, dist] = read16();
        if (visible) tags.push({ peer, x, y, dist, by: r.by, nick: r.p.nm || "", color: r.p.c & 3 });
      }
      onTags(tags);
    }

    // 4. Publish ourselves.
    if (inLevel) {
      room.presence({
        v: PROTOCOL, nm: nick, c: color, map,
        x: L[0], y: L[1], z: L[2], a: L[3] >>> 0,
        d: L[7], m: L[8], w: L[6], f: L[9], hp: L[4],
        h: hitRing, kb: killedBy, s: suicides,
      }).catch(() => {});
    }

    onScore && onScore(scoreboard());
  }

  function scoreboard() {
    const fragsOf = (peer) => {
      let n = 0;
      for (const [victim, r] of others) if (victim !== peer) n += (r.p.kb && r.p.kb[peer]) | 0;
      if (peer !== myPeer) n += killedBy[peer] | 0;
      return n;
    };
    const rows = [{ peer: myPeer, me: true, nick, frags: fragsOf(myPeer) - suicides }];
    for (const [peer, r] of others) rows.push({ peer, me: false, by: r.by, color: r.p.c & 3, nick: r.p.nm || "", frags: fragsOf(peer) - ((r.p.s | 0)) });
    rows.sort((a, b) => b.frags - a.frags);
    return rows;
  }

  return {
    tick,
    get peer() { return myPeer; },
    setNick(n) { nick = String(n || "").slice(0, 20); },
    stop() { unsubPeers(); for (const peer of [...others.keys()]) release(peer); },
  };
}
