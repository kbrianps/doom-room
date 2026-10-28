// Loads doom.wasm with a tiny in-memory WASI layer and runs it on a canvas.
// The only real file is the IWAD; everything Doom writes (config, saves) is
// accepted and thrown away.

const ERRNO = { SUCCESS: 0, BADF: 8, INVAL: 28, NOENT: 44, NOSYS: 52 };
const FILETYPE = { CHAR: 2, DIR: 3, FILE: 4 };
const ROOT_FD = 3;

export async function startDoom({ canvas, wasmUrl, wadUrl, wadName, args = [], onTitle, onStatus, onTick, fetchImpl = fetch }) {
  const status = (s) => onStatus && onStatus(s);

  status("Loading the engine...");
  const wasmBytes = await (await fetchImpl(wasmUrl)).arrayBuffer();

  status("Loading the maps...");
  const wad = await loadWad(fetchImpl, wadUrl);

  let memory;
  const mem8 = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  const cstr = (ptr) => {
    const m = mem8();
    let end = ptr;
    while (m[end]) end++;
    return new TextDecoder().decode(m.subarray(ptr, end));
  };

  // Open files: fd -> { data, pos, kind }
  const files = new Map();
  let nextFd = ROOT_FD + 1;
  let lineBuf = "";

  const argv = ["doom", "-iwad", wadName, ...args];
  const enc = new TextEncoder();

  const wasi = {
    args_sizes_get(argcPtr, sizePtr) {
      const v = view();
      v.setUint32(argcPtr, argv.length, true);
      v.setUint32(sizePtr, argv.reduce((n, a) => n + enc.encode(a).length + 1, 0), true);
      return ERRNO.SUCCESS;
    },
    args_get(argvPtr, bufPtr) {
      const v = view(), m = mem8();
      argv.forEach((a, i) => {
        const b = enc.encode(a);
        v.setUint32(argvPtr + i * 4, bufPtr, true);
        m.set(b, bufPtr);
        m[bufPtr + b.length] = 0;
        bufPtr += b.length + 1;
      });
      return ERRNO.SUCCESS;
    },
    clock_time_get(_id, _precision, outPtr) {
      const ns = BigInt(Math.round(performance.now() * 1e6)) + 1_700_000_000_000_000_000n;
      view().setBigUint64(outPtr, ns, true);
      return ERRNO.SUCCESS;
    },
    fd_prestat_get(fd, outPtr) {
      if (fd !== ROOT_FD) return ERRNO.BADF;
      const v = view();
      v.setUint8(outPtr, 0); // preopen type: dir
      v.setUint32(outPtr + 4, 1, true); // name length of "/"
      return ERRNO.SUCCESS;
    },
    fd_prestat_dir_name(fd, pathPtr, len) {
      if (fd !== ROOT_FD) return ERRNO.BADF;
      mem8()[pathPtr] = 47; // "/"
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get(fd, outPtr) {
      const v = view();
      let type;
      if (fd <= 2) type = FILETYPE.CHAR;
      else if (fd === ROOT_FD) type = FILETYPE.DIR;
      else if (files.has(fd)) type = FILETYPE.FILE;
      else return ERRNO.BADF;
      v.setUint8(outPtr, type);
      v.setUint16(outPtr + 2, 0, true);
      v.setBigUint64(outPtr + 8, 0xffffffffffffffffn, true);
      v.setBigUint64(outPtr + 16, 0xffffffffffffffffn, true);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_set_flags() { return ERRNO.SUCCESS; },
    path_open(dirFd, _dirflags, pathPtr, pathLen, oflags, _rb, _ri, _fdflags, outFdPtr) {
      if (dirFd !== ROOT_FD) return ERRNO.BADF;
      const path = new TextDecoder().decode(mem8().subarray(pathPtr, pathPtr + pathLen)).replace(/^\.?\/+/, "");
      const create = (oflags & 1) !== 0;
      let entry;
      if (path.toLowerCase() === wadName.toLowerCase()) entry = { data: wad, pos: 0, kind: "wad" };
      else if (create) entry = { data: new Uint8Array(0), pos: 0, kind: "sink" };
      else return ERRNO.NOENT;
      const fd = nextFd++;
      files.set(fd, entry);
      view().setUint32(outFdPtr, fd, true);
      return ERRNO.SUCCESS;
    },
    fd_close(fd) {
      files.delete(fd);
      return ERRNO.SUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      const f = files.get(fd);
      if (!f) return ERRNO.BADF;
      const v = view(), m = mem8();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, f.data.length - f.pos);
        if (n <= 0) break;
        m.set(f.data.subarray(f.pos, f.pos + n), ptr);
        f.pos += n;
        total += n;
      }
      v.setUint32(nreadPtr, total, true);
      return ERRNO.SUCCESS;
    },
    fd_seek(fd, offset, whence, outPtr) {
      const f = files.get(fd);
      if (!f) return ERRNO.BADF;
      const off = Number(offset);
      if (whence === 0) f.pos = off;
      else if (whence === 1) f.pos += off;
      else if (whence === 2) f.pos = f.data.length + off;
      else return ERRNO.INVAL;
      view().setBigUint64(outPtr, BigInt(f.pos), true);
      return ERRNO.SUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      const v = view(), m = mem8();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 || fd === 2) {
          lineBuf += new TextDecoder().decode(m.subarray(ptr, ptr + len));
          let nl;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            console.log("[doom]", lineBuf.slice(0, nl));
            lineBuf = lineBuf.slice(nl + 1);
          }
        } else if (!files.has(fd)) {
          return ERRNO.BADF;
        }
        total += len;
      }
      v.setUint32(nwrittenPtr, total, true);
      return ERRNO.SUCCESS;
    },
    path_create_directory() { return ERRNO.SUCCESS; },
    path_remove_directory() { return ERRNO.NOSYS; },
    path_rename() { return ERRNO.NOSYS; },
    path_unlink_file() { return ERRNO.SUCCESS; },
    proc_exit(code) {
      throw new DoomExit(code);
    },
  };

  const ctx = canvas.getContext("2d");
  let image = null, image32 = null;

  const env = {
    js_now_ms: () => performance.now(),
    js_set_title: (ptr) => onTitle && onTitle(cstr(ptr)),
    js_draw_frame(ptr, w, h) {
      if (!image || image.width !== w) {
        canvas.width = w;
        canvas.height = h;
        image = ctx.createImageData(w, h);
        image32 = new Uint32Array(image.data.buffer);
      }
      // Doom writes 0x00RRGGBB; the canvas wants bytes R,G,B,A.
      const src = new Uint32Array(memory.buffer, ptr, w * h);
      for (let i = 0; i < src.length; i++) {
        const p = src[i];
        image32[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
      }
      ctx.putImageData(image, 0, 0);
    },
  };

  status("Starting...");
  const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi, env });
  memory = instance.exports.memory;
  const ex = instance.exports;
  ex._initialize();

  // argv was already passed through WASI; doomgeneric still wants argc/argv,
  // so hand it a copy in wasm memory.
  const argvPtr = ex.dg_malloc(argv.length * 4);
  argv.forEach((a, i) => {
    const b = enc.encode(a);
    const p = ex.dg_malloc(b.length + 1);
    mem8().set(b, p);
    mem8()[p + b.length] = 0;
    view().setUint32(argvPtr + i * 4, p, true);
  });

  const guard = (fn) => {
    try { fn(); }
    catch (e) {
      if (e instanceof DoomExit) { status(`Doom exited (code ${e.code})`); running = false; return; }
      running = false;
      status("Error: " + e.message);
      throw e;
    }
  };

  let running = true;
  // Different random table offset per tab, so players don't all spawn on
  // the same deathmatch start.
  ex.net_seed?.(crypto.getRandomValues(new Uint8Array(1))[0]);
  guard(() => ex.dg_create(argv.length, argvPtr));

  // Run one Doom tick per 35 Hz tic; rAF just tells us when to look.
  let lastTic = -1;
  const loop = () => {
    if (!running) return;
    const tic = Math.floor((performance.now() * 35) / 1000);
    if (tic !== lastTic) {
      lastTic = tic;
      guard(() => { ex.dg_tick(); onTick && onTick(); });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  status("");

  return {
    exports: ex,
    memory: () => memory,
    key: (pressed, code) => ex.dg_push_key(pressed ? 1 : 0, code),
    mouse: (buttons, dx) => ex.dg_mouse(buttons, dx),
    stop: () => { running = false; },
  };
}

// The WAD ships gzipped inside a data-only wasm module (see tools/pack_wasm.py):
// its memory starts with a u32 length followed by the gzip bytes.
async function loadWad(fetchImpl, url) {
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`WAD: HTTP ${resp.status}`);
  let gz;
  if (url.endsWith(".wasm")) {
    const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
    const buf = instance.exports.memory.buffer;
    const len = new DataView(buf).getUint32(0, true);
    gz = new Uint8Array(buf, 4, len);
  } else {
    gz = new Uint8Array(await resp.arrayBuffer());
  }
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) return gz.slice(); // not compressed
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class DoomExit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

// Browser KeyboardEvent.code -> Doom key code (doomkeys.h).
export const DOOM_KEYS = {
  ArrowUp: 0xad, ArrowDown: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
  KeyW: 0xad, KeyS: 0xaf, KeyA: 0xa0, KeyD: 0xa1,
  ControlLeft: 0xa3, ControlRight: 0xa3, Space: 0xa2, KeyE: 0xa2,
  ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36, AltLeft: 0x80 + 0x38, AltRight: 0x80 + 0x38,
  Enter: 13, Escape: 27, Tab: 9, Backspace: 0x7f,
  Equal: 0x3d, Minus: 0x2d,
  Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53, Digit6: 54, Digit7: 55,
  KeyY: 121, KeyN: 110,
};
