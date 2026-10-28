// Runs doom.wasm headless for 4 seconds and saves the last frame as frame.ppm.
// Usage: node tools/smoke.mjs [doom args...]
import { readFileSync, writeFileSync } from "node:fs";
import { startDoom } from "../web/doom.js";
const root = new URL("../web/", import.meta.url);
const fetchImpl = async (u) => new Response(readFileSync(new URL(u, root)));
let last = null;
const canvas = { width: 0, height: 0, getContext: () => ({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: (img) => { last = img; },
}) };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 8);
const args = process.argv.slice(2);
const d = await startDoom({ canvas, wasmUrl: "doom.wasm", wadUrl: "freedm.wad.wasm", wadName: "freedm.wad", args, fetchImpl,
  onStatus: (s) => s && console.log("status:", s), onTitle: (t) => console.log("title:", t) });
await new Promise((r) => setTimeout(r, 4000));
d.stop();
if (last) {
  const { width: w, height: h, data } = last;
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { out[i*3] = data[i*4]; out[i*3+1] = data[i*4+1]; out[i*3+2] = data[i*4+2]; }
  writeFileSync(process.env.OUT || "frame.ppm", Buffer.concat([Buffer.from(`P6 ${w} ${h} 255\n`), out]));
  console.log("frame saved", w, h);
} else console.log("no frame");
process.exit(0);
