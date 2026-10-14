"""按 spiffs_assets_gen.py 的 mmap 格式打包 assets.bin（name_length=32）。

用法：pack.py <目录> <输出.bin> [宽高表.json]
"""
import json
import os
import struct
import sys

NAME_LEN = 32


def pack(src, out, dims=None):
    dims = dims or {}
    files = sorted(os.listdir(src), key=lambda f: (os.path.splitext(f)[1], os.path.splitext(f)[0]))
    data, table = bytearray(), bytearray()
    for name in files:
        blob = open(os.path.join(src, name), "rb").read()
        w, h = dims.get(name, (0, 0))
        table += name.encode().ljust(NAME_LEN, b"\0")[:NAME_LEN]
        table += struct.pack("<IIHH", len(blob), len(data), w, h)
        data += b"\x5A\x5A" + blob
    body = table + data
    final = struct.pack("<III", len(files), sum(body) & 0xFFFF, len(body)) + body
    open(out, "wb").write(final)
    return len(files), len(final)


if __name__ == "__main__":
    dims = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None
    print(*pack(sys.argv[1], sys.argv[2], dims))
