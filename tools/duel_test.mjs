// End-to-end multiplayer test, no browser needed.
//
// Two Doom instances run in this process and talk through a fake `room` with
// the real capability's shape: presence merged per peer and delivered,
// coalesced, about 30 times a second. B's published position is pinned in
// front of A; A holds fire until B dies. Passes when B dies, both sides
// credit the frag to A, and A comes out untouched.

import { readFileSync } from "node:fs";
import { startDoom } from "../web/doom.js";
import { startNet } from "../web/net.js";

const root = new URL("../web/", import.meta.url);
const fetchImpl = async (u) => new Response(readFileSync(new URL(u, root)));
globalThis.requestAnimationFrame = (f) => setTimeout(f, 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHub() {
  const members = new Map();
  const view = (x, me) => Object.freeze({
    peer: x.peer, by: null, isMe: x.peer === me, sameTab: x.peer === me,
    kind: "viewer", guest: false, presence: Object.freeze({ ...x.presence }), updatedAt: Date.now(),
  });
  setInterval(() => {
    const changed = [...members.values()].filter((m) => m.dirty);
    if (!changed.length) return;
    for (const m of changed) m.dirty = false;
    for (const [peer, m] of members) {
      const peers = [...members.values()].map((x) => view(x, peer));
      const updated = changed.map((x) => view(x, peer));
      for (const h of m.handlers) h({ peers, joined: [], left: [], updated });
    }
  }, 33).unref();
  return {
    join(peer, transform = (p) => p) {
      const me = { peer, presence: {}, handlers: [], dirty: true };
      members.set(peer, me);
      return {
        onPeers(h) {
          me.handlers.push(h);
          setTimeout(() => {
            const peers = [...members.values()].map((x) => view(x, peer));
            h({ peers, joined: peers, left: [], updated: [] });
          });
          return () => {};
        },
        async presence(patch) { me.presence = transform({ ...me.presence, ...patch }); me.dirty = true; },
      };
    },
  };
}

async function player(name) {
  const box = {};
  const canvas = { getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  }) };
  box.doom = await startDoom({
    canvas, fetchImpl, wasmUrl: "doom.wasm", wadUrl: "freedm.wad.wasm", wadName: "freedm.wad",
    args: ["-altdeath", "-warp", "1", "-nomonsters"],
    onStatus: (s) => s && s.startsWith("Error") && console.error(name, s),
    onTick: () => box.net && box.net.tick(),
  });
  box.local = () => {
    const buf = box.doom.exports.dg_malloc(64);
    box.doom.exports.net_local(buf);
    return Array.from(new Int32Array(box.doom.memory().buffer, buf, 16));
  };
  return box;
}

const hub = makeHub();
const A = await player("A");
const B = await player("B");
const feeds = { A: [], B: [] };

let aPose = null;
let aTags = [];
A.net = startNet({ doom: A.doom, room: hub.join("peerA", (p) => (aPose = p)), color: 1,
  onFeed: (e) => feeds.A.push(e), onTags: (t) => { if (t.length) aTags = t; } });
B.net = startNet({ doom: B.doom, color: 3, nick: "Bravo", onFeed: (e) => feeds.B.push(e),
  room: hub.join("peerB", (p) => {
    if (!aPose) return p;
    const a = (aPose.a / 2 ** 32) * 2 * Math.PI;
    const ahead = 96 * 65536;
    return { ...p, x: aPose.x + Math.round(Math.cos(a) * ahead), y: aPose.y + Math.round(Math.sin(a) * ahead), z: aPose.z };
  }) });

await sleep(1500);
A.doom.key(true, 0xa3); // KEY_FIRE
const t0 = Date.now();
let diedAfter = null;
while (Date.now() - t0 < 15000 && diedAfter === null) {
  await sleep(100);
  if (B.local()[7]) diedAfter = Date.now() - t0;
}
A.doom.key(false, 0xa3);
await sleep(500);

const credited = (list) => list.some((e) => e.killer === "peerA" && e.victim === "peerB");
const checks = [
  ["B died from A's shots", diedAfter !== null, diedAfter !== null ? `${diedAfter} ms` : "timed out"],
  ["B credits the frag to A", credited(feeds.B), JSON.stringify(feeds.B)],
  ["A sees its own frag", credited(feeds.A), JSON.stringify(feeds.A)],
  ["A sees B's name tag above its head", aTags.some((t) => t.peer === "peerB" && t.nick === "Bravo" && t.y < 100),
    JSON.stringify(aTags.map(({ peer, nick, x, y }) => ({ peer, nick, x, y })))],
  ["A is untouched", A.local()[4] === 100 && Object.keys(aPose?.kb || {}).length === 0, `health ${A.local()[4]}`],
];
let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  ok &&= pass;
}
process.exit(ok ? 0 : 1);
