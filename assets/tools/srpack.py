"""按 esp-sr srmodels.bin 格式打包模型（与 pack_model.py / WakenetModelPacker.js 相同）。

用法：
  srpack.py verify <原 srmodels.bin>         解包后按原顺序重打包，比对是否逐字节一致
  srpack.py pack <输出.bin> <模型目录>...     每个目录名即模型名，目录内文件按名字排序
"""
import os
import struct
import sys


def unpack(data):
    n = struct.unpack("<I", data[:4])[0]
    off, models = 4, []
    for _ in range(n):
        name = data[off:off + 32].rstrip(b"\0").decode()
        fn = struct.unpack("<I", data[off + 32:off + 36])[0]
        off += 36
        files = []
        for _ in range(fn):
            fname = data[off:off + 32].rstrip(b"\0").decode()
            start, length = struct.unpack("<II", data[off + 32:off + 40])
            off += 40
            files.append((fname, data[start:start + length]))
        models.append((name, files))
    return models


def pack(models):
    header_len = 4 + sum(36 + 40 * len(files) for _, files in models)
    header, body = bytearray(struct.pack("<I", len(models))), bytearray()
    pos = header_len
    for name, files in models:
        header += name.encode().ljust(32, b"\0") + struct.pack("<I", len(files))
        for fname, blob in files:
            header += fname.encode().ljust(32, b"\0") + struct.pack("<II", pos, len(blob))
            pos += len(blob)
    for _, files in models:
        for _, blob in files:
            body += blob
    return bytes(header + body)


if __name__ == "__main__":
    if sys.argv[1] == "verify":
        orig = open(sys.argv[2], "rb").read()
        print("逐字节一致:", pack(unpack(orig)) == orig)
    else:
        models = []
        for d in sorted(sys.argv[3:], key=os.path.basename):
            names = sorted(os.listdir(d))
            models.append((os.path.basename(d), [(f, open(os.path.join(d, f), "rb").read()) for f in names]))
        out = pack(models)
        open(sys.argv[2], "wb").write(out)
        print(len(models), "models", len(out), "bytes")
