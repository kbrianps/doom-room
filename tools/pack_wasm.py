"""Wrap an arbitrary binary file in a data-only WebAssembly module.

The module exports one memory; the first 4 bytes (little endian) hold the
payload length and the payload follows. Artifacts serve .wasm but not
arbitrary binaries, so this is how the WAD ships.
"""
import struct, sys

def leb(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)

def section(sid, body):
    return bytes([sid]) + leb(len(body)) + body

payload = open(sys.argv[1], 'rb').read()
blob = struct.pack('<I', len(payload)) + payload
pages = (len(blob) + 65535) // 65536
mem = section(5, leb(1) + b'\x00' + leb(pages))
exp = section(7, leb(1) + leb(6) + b'memory' + b'\x02' + leb(0))
seg = b'\x00' + b'\x41\x00\x0b' + leb(len(blob)) + blob  # active, i32.const 0
data = section(11, leb(1) + seg)
open(sys.argv[2], 'wb').write(b'\x00asm\x01\x00\x00\x00' + mem + exp + data)
