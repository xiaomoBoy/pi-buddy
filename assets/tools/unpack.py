"""解包 pack.py 生成的 assets.bin（mmap 格式，name_length=32），并输出宽高表。

用法：unpack.py <assets.bin> <输出目录>
"""
import json
import os
import struct
import sys

NAME_LEN = 32


def unpack(path, out):
    data = open(path, "rb").read()
    count, _checksum, _length = struct.unpack("<III", data[:12])
    entry = NAME_LEN + 12
    base = 12 + count * entry
    os.makedirs(out, exist_ok=True)
    dims = {}
    for i in range(count):
        e = data[12 + i * entry:12 + (i + 1) * entry]
        name = e[:NAME_LEN].rstrip(b"\0").decode()
        size, offset, w, h = struct.unpack("<IIHH", e[NAME_LEN:])
        assert data[base + offset:base + offset + 2] == b"\x5A\x5A", name
        open(os.path.join(out, name), "wb").write(data[base + offset + 2:base + offset + 2 + size])
        if w or h:
            dims[name] = [w, h]
    json.dump(dims, open(os.path.join(out, "..", os.path.basename(out) + ".dims.json"), "w"))
    return count


if __name__ == "__main__":
    print(unpack(sys.argv[1], sys.argv[2]), "files")
