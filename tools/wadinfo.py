import struct, sys, collections
d = open(sys.argv[1], 'rb').read()
kind, n, off = struct.unpack('<4sii', d[:12])
lumps = [struct.unpack('<ii8s', d[off+16*i:off+16*i+16]) for i in range(n)]
groups = collections.Counter()
cur = None
for pos, size, name in lumps:
    name = name.rstrip(b'\0').decode()
    if name.startswith('MAP') and size == 0: cur = name
    elif name in ('THINGS','LINEDEFS','SIDEDEFS','VERTEXES','SEGS','SSECTORS','NODES','SECTORS','REJECT','BLOCKMAP','BEHAVIOR'): groups['maps'] += size; groups[cur] += size; continue
    else: cur = None
    if name.startswith('D_'): groups['music'] += size
    elif name.startswith('DS'): groups['sfx'] += size
    elif name.startswith('DP'): groups['pcsfx'] += size
    else: groups['other'] += size
print(kind, n, 'lumps')
for k, v in sorted(groups.items(), key=lambda x: -x[1])[:45]: print(f'{k:10} {v/1e6:6.2f} MB')
