// Records a side-by-side duel between two engines as a GIF and an MP4.
//
// Both tabs run headless in this process on a simulated clock, so every
// output frame is exactly one Doom tic. Two small bots aim at each other
// and fire when the other marine is really on screen. The room is a fake
// that delivers presence every tic. Name tags are drawn over the frames at
// the positions net.js reports, like the page does with HTML.
//
//   node tools/record_gif.mjs probe              find seed pairs that spawn in sight
//   node tools/record_gif.mjs record SA SB OUT   OUT.gif and OUT.mp4 (needs ffmpeg)

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { startDoom } from "../web/doom.js";
import { startNet } from "../web/net.js";

// ---- simulated clock, seeds and rAF ----------------------------------------

let now = 0;
let booting = false; // while booting the engine busy-waits on the clock, so let it run
let seed = 0;
let rafQueue = [];
Object.defineProperty(globalThis, "performance", { value: { now: () => (booting ? (now += 0.05) : now) }, configurable: true });
Object.defineProperty(globalThis, "crypto", {
  value: { getRandomValues: (a) => { a[0] = seed; return a; } }, configurable: true,
});
globalThis.requestAnimationFrame = (f) => rafQueue.push(f);

const root = new URL("../web/", import.meta.url);
const files = {};
const fetchImpl = async (u) => new Response((files[u] ??= readFileSync(new URL(u, root))));

const W = 320, H = 200;
const KEY = { fwd: 0xad, sl: 0xa0, sr: 0xa1, fire: 0xa3, use: 0xa2 };

// ---- fake room, delivered synchronously ------------------------------------

function makeHub() {
  const members = new Map();
  const view = (x, me) => Object.freeze({
    peer: x.peer, by: null, isMe: x.peer === me, sameTab: x.peer === me,
    kind: "viewer", guest: false, presence: Object.freeze({ ...x.presence }), updatedAt: now,
  });
  return {
    flush() {
      const changed = [...members.values()].filter((m) => m.dirty);
      if (!changed.length) return;
      for (const m of changed) m.dirty = false;
      for (const [peer, m] of members) {
        const peers = [...members.values()].map((x) => view(x, peer));
        for (const h of m.handlers) h({ peers, joined: [], left: [], updated: changed.map((x) => view(x, peer)) });
      }
    },
    join(peer) {
      const me = { peer, presence: {}, handlers: [], dirty: true };
      members.set(peer, me);
      return {
        onPeers(h) {
          me.handlers.push(h);
          const peers = [...members.values()].map((x) => view(x, peer));
          h({ peers, joined: peers, left: [], updated: [] });
          return () => {};
        },
        async presence(patch) { me.presence = { ...me.presence, ...patch }; me.dirty = true; },
      };
    },
  };
}

// ---- one player ------------------------------------------------------------

async function player(name, s) {
  const P = { name, frame: null, tags: [], keys: new Set() };
  const canvas = { getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img) { P.frame = img.data; },
  }) };
  seed = s;
  booting = true;
  P.doom = await startDoom({
    canvas, fetchImpl, wasmUrl: "doom.wasm", wadUrl: "freedm.wad.wasm", wadName: "freedm.wad",
    args: ["-altdeath", "-warp", "1", "-nomonsters"],
    onStatus: (m) => m && m.startsWith("Error") && console.error(name, m),
    onTick: () => P.net && P.net.tick(),
  });
  booting = false;
  const buf = P.doom.exports.dg_malloc(64);
  P.local = () => {
    P.doom.exports.net_local(buf);
    return Array.from(new Int32Array(P.doom.memory().buffer, buf, 16));
  };
  // The other marine as this player sees it: [x, y, visible, dist] or null.
  P.sees = () => {
    for (let slot = 0; slot < 16; slot++) {
      P.doom.exports.net_ghost_screen(slot, buf);
      const o = Array.from(new Int32Array(P.doom.memory().buffer, buf, 4));
      if (o[2]) return o;
    }
    return null;
  };
  P.set = (k, on) => {
    if (on === P.keys.has(k)) return;
    on ? P.keys.add(k) : P.keys.delete(k);
    P.doom.key(on, k);
  };
  // Game keys are read once per tic, so hold a tap across two tics.
  P.releases = [];
  P.tap = (k) => { P.doom.key(true, k); P.releases.push([k, 2]); };
  return P;
}

// One tic for everybody: advance the clock, run each engine once, deliver presence.
function step(hub, players) {
  now += 1000 / 35;
  const q = rafQueue;
  rafQueue = [];
  for (const f of q) f();
  hub.flush();
  for (const P of players) P.releases = P.releases.filter((r) => (--r[1] > 0 ? true : (P.doom.key(false, r[0]), false)));
}

async function match(sa, sb) {
  const hub = makeHub();
  const A = await player("ALPHA", sa);
  const B = await player("BRAVO", sb);
  A.net = startNet({ doom: A.doom, room: hub.join("A"), color: 0, nick: "Alpha", onTags: (t) => (A.tags = t) });
  B.net = startNet({ doom: B.doom, room: hub.join("B"), color: 3, nick: "Bravo", onTags: (t) => (B.tags = t) });
  A.other = B; B.other = A;
  return { hub, A, B, step: () => step(hub, [A, B]) };
}

// ---- bots ------------------------------------------------------------------

const BAM = 2 ** 32;
const toBam = (rad) => Math.round((rad / (2 * Math.PI)) * BAM) >>> 0;
const sdiff = (a, b) => (((a - b + 2 ** 31) >>> 0) - 2 ** 31);

function bot(P, tic, armed, opts) {
  const me = P.local();
  const them = P.other.local();
  if (!me[10]) return;
  if (me[7]) { // dead: let go of everything, respawn after a beat
    for (const k of [...P.keys]) P.set(k, false);
    P.deadFor = (P.deadFor || 0) + 1;
    if (P.deadFor > 45 && P.deadFor % 10 === 0) P.tap(KEY.use);
    return;
  }
  P.deadFor = 0;
  const dx = them[0] - me[0], dy = them[1] - me[1];
  const dist = Math.hypot(dx, dy) / 65536;
  const want = toBam(Math.atan2(dy, dx) + opts.aimError(tic));
  const diff = sdiff(want, me[3] >>> 0);
  const mouse = Math.max(-opts.turn, Math.min(opts.turn, Math.round((-diff * opts.gain) / (8 * 65536))));
  if (mouse) P.doom.mouse(0, mouse);

  const seen = P.sees();
  const aligned = Math.abs(diff) < toBam((4 * Math.PI) / 180);
  P.set(KEY.fire, Boolean(armed && seen && aligned && !them[7]));

  // Close in when far, strafe from side to side when in sight.
  P.set(KEY.fwd, dist > opts.keep);
  const side = Math.floor((tic + opts.phase) / opts.strafe) % 2 ? KEY.sl : KEY.sr;
  P.set(KEY.sl, Boolean(seen) && side === KEY.sl);
  P.set(KEY.sr, Boolean(seen) && side === KEY.sr);
}

// ---- drawing ---------------------------------------------------------------

// 5x7 pixel glyphs for the few letters we need.
const GLYPHS = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};
const COLORS = { 0: [90, 220, 90], 3: [235, 70, 60] };

function text(out, ow, x0, y0, str, rgb, outline) {
  const plot = (x, y, c) => {
    if (x < 0 || y < 0 || x >= ow || y * ow * 4 >= out.length) return;
    const i = (y * ow + x) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  };
  const on = (gx, gy) => {
    const ch = GLYPHS[str[Math.floor(gx / 6)]];
    const cx = gx % 6;
    return ch && cx < 5 && gy >= 0 && gy < 7 && ch[gy][cx] === "1";
  };
  const w = str.length * 6 - 1;
  for (let gy = -1; gy <= 7; gy++)
    for (let gx = -1; gx <= w; gx++) {
      if (on(gx, gy)) plot(x0 + gx, y0 + gy, rgb);
      else if (outline && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => on(gx + a, gy + b))) plot(x0 + gx, y0 + gy, [0, 0, 0]);
    }
  return w;
}

const HEAD = 11, GAP = 2;
const OW = W * 2 + GAP, OH = H + HEAD;

function compose(A, B) {
  const out = new Uint8Array(OW * OH * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 18; out[i + 3] = 255; }
  [A, B].forEach((P, n) => {
    const ox = n * (W + GAP);
    if (P.frame) for (let y = 0; y < H; y++) {
      const src = P.frame.subarray(y * W * 4, (y + 1) * W * 4);
      out.set(src, ((y + HEAD) * OW + ox) * 4);
    }
    const label = P.name;
    text(out, OW, ox + Math.round((W - (label.length * 6 - 1)) / 2), 2, label, P === A ? COLORS[0] : COLORS[3], false);
    for (const t of P.tags) {
      const s = t.nick.toUpperCase();
      const w = s.length * 6 - 1;
      text(out, OW, ox + t.x - Math.round(w / 2), HEAD + t.y - 9, s, COLORS[t.color] || [255, 255, 255], true);
    }
  });
  return out;
}

// ---- modes -----------------------------------------------------------------

const opts = {
  A: { gain: 0.35, turn: 140, keep: 380, strafe: 31, phase: 0, aimError: (t) => Math.sin(t / 9) * 0.03 },
  B: { gain: 0.3, turn: 120, keep: 420, strafe: 23, phase: 11, aimError: (t) => Math.cos(t / 7) * 0.05 },
};

const CHEAT = [..."idkfa"].map((c) => c.charCodeAt(0));

function setup(m, tic) {
  if (tic === 3) for (const P of [m.A, m.B]) for (const c of CHEAT) { P.doom.key(true, c); P.doom.key(false, c); }
  if (tic === 40) { m.A.tap(53); m.B.tap(52); } // 5: rocket launcher, 4: chaingun
}

async function probe() {
  const spots = new Map();
  for (let s = 0; s < 256; s += 3) {
    const m = await match(s, (s + 128) % 256);
    for (let t = 0; t < 4; t++) m.step();
    const L = m.A.local();
    const key = `${L[0] >> 16},${L[1] >> 16}`;
    if (!spots.has(key)) spots.set(key, { seed: s, x: L[0] >> 16, y: L[1] >> 16 });
    m.A.doom.stop(); m.B.doom.stop();
  }
  const list = [...spots.values()];
  console.log("spawn spots:", list.map((p) => `${p.seed}@${p.x},${p.y}`).join("  "));
  for (const a of list) for (const b of list) {
    if (a.seed >= b.seed) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < 250 || d > 1400) continue;
    const m = await match(a.seed, b.seed);
    let seenA = 0, seenB = 0;
    for (let t = 0; t < 70; t++) {
      m.step();
      bot(m.A, t, false, { ...opts.A, keep: 1e9 });
      bot(m.B, t, false, { ...opts.B, keep: 1e9 });
      if (t > 35) { seenA += !!m.A.sees(); seenB += !!m.B.sees(); }
    }
    m.A.doom.stop(); m.B.doom.stop();
    if (seenA > 5 && seenB > 5) console.log(`in sight: ${a.seed} ${b.seed}  dist ${Math.round(d)}  seen ${seenA}/${seenB}`);
  }
}

async function record(sa, sb, outBase) {
  const m = await match(sa, sb);
  const START = 150, MAX = 35 * 22;
  const ff = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${OW}x${OH}`, "-r", "35", "-i", "-",
    "-vf", "scale=iw*2:ih*2:flags=neighbor", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", `${outBase}.mp4`,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  let kills = 0, lastDeaths = [0, 0], endAt = Infinity;
  for (let tic = 0; tic < START + MAX && tic < endAt; tic++) {
    setup(m, tic);
    m.step();
    if (tic > 20) { bot(m.A, tic, tic >= START, opts.A); bot(m.B, tic, tic >= START, opts.B); }
    [m.A, m.B].forEach((P, i) => {
      const d = P.local()[12];
      if (d !== lastDeaths[i]) { lastDeaths[i] = d; kills++; console.log(`tic ${tic}: ${P.name} died`); }
    });
    if (kills >= 1 && endAt === Infinity) endAt = tic + 105;
    if (tic >= START && !ff.stdin.write(compose(m.A, m.B))) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  // GIF from the MP4: 20 fps, palette tuned on the whole clip.
  await new Promise((r, j) => spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-i", `${outBase}.mp4`, "-vf",
    `fps=${process.env.FPS || 15},scale=iw*${process.env.SCALE || 0.75}:-1:flags=neighbor,split[a][b];[a]palettegen=max_colors=${process.env.COLORS || 64}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    `${outBase}.gif`,
  ], { stdio: "inherit" }).on("close", (c) => (c ? j(new Error("ffmpeg " + c)) : r())));
  m.A.doom.stop(); m.B.doom.stop();
  console.log(`kills: ${kills}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "probe") await probe();
else if (mode === "record") await record(+rest[0], +rest[1], rest[2] || "duel");
else console.log("usage: record_gif.mjs probe | record SEED_A SEED_B OUT");
process.exit(0);
