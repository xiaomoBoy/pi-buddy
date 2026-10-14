"""P 仔 21 个表情生成器：基于《Pi 蓝皮书》logo（米白 P + 青蓝圆点），纯 Python 输出 RGBA PNG。

脸画在 P 的“洞”里（x 4..8, y 3..6），和 assets/mascot/draw.py 的 P 仔一致。
用法：gen_emoji.py <输出目录> [预览.png]
"""
import os
import struct
import sys
import zlib

OUT = sys.argv[1]
SCALE = 6
X0, X1 = -6, 19   # 网格列范围（含），与像素小怪相同，输出 156x168
Y0, Y1 = -6, 21

C = (0xF8, 0xF5, 0xED, 255)   # 米白：P 身体
T = (0x4F, 0x90, 0xAA, 255)   # 青蓝：圆点、眼泪
D = (0x27, 0x6D, 0x89, 255)   # 深青：墨镜、z
A = (0xF1, 0xBE, 0x58, 255)   # 琥珀：星星、感叹号、问号
R = (0xE5, 0x64, 0x5A, 255)   # 珊瑚：爱心、腮红、舌头、生气
M = (0xA9, 0xB0, 0xB5, 255)   # 灰：小装饰

P_ROWS = [
    "#########...",
    "###########.",
    "############",
    "####.....###",
    "####.....###",
    "####.....###",
    "####.....###",
    "############",
    "###########.",
    "#########...",
    "####........",
    "####........",
    "####........",
    "####........",
    "####........",
    "####........",
]
DOT = [".oo.", "oooo", "oooo", ".oo."]


def px(x, y, c):
    return [(x, y, c)]


def body(dy=0, squash=False, color=C):
    out = []
    for y, row in enumerate(P_ROWS):
        for x, ch in enumerate(row):
            if ch != "#":
                continue
            if squash and y == 15:
                continue
            yy = y + dy + (1 if squash and y < 10 else 0)
            out.append((x, yy, color))
    return out


def dot(x, y, c=T):
    return [(x + cx, y + cy, c) for cy, r in enumerate(DOT) for cx, ch in enumerate(r) if ch == "o"]


def heart(x, y, c=R):
    return [(x, y, c), (x + 2, y, c), (x, y + 1, c), (x + 1, y + 1, c), (x + 2, y + 1, c), (x + 1, y + 2, c)]


def shift(cells, dy):
    return [(x, y + dy, c) for x, y, c in cells]


# 脸：坐标都在 P 的洞里（x 4..8, y 3..6）
EYES_OPEN = [(5, 4, C), (5, 5, C), (7, 4, C), (7, 5, C)]
EYES_UP = [(5, 3, C), (5, 4, C), (7, 3, C), (7, 4, C)]
EYES_DOWN = [(5, 5, C), (5, 6, C), (7, 5, C), (7, 6, C)]
EYES_WIDE = [(x, y, C) for x0 in (4, 7) for x in (x0, x0 + 1) for y in (4, 5)]
EYES_HAPPY = [(4, 5, C), (5, 4, C), (6, 5, C), (6, 5, C), (7, 4, C), (8, 5, C)]
EYES_CLOSED = [(4, 5, C), (5, 5, C), (7, 5, C), (8, 5, C)]
MOUTH = [(5, 6, C), (6, 6, C), (7, 6, C)]
BLUSH = [(4, 6, R), (8, 6, R)]
SPARKS = [(-3, -2, C), (15, 2, C), (-2, 6, C), (16, -2, C), (14, -6, C)]
STAR = [(1, 0, A), (0, 1, A), (1, 1, A), (2, 1, A), (1, 2, A)]
Z = [(0, 0), (1, 0), (2, 0), (1, 1), (0, 2), (1, 2), (2, 2)]


def at(shape, x, y):
    return [(x + sx, y + sy, c) for sx, sy, c in shape]


E = {}
E["neutral"] = body() + EYES_OPEN + dot(8, 12)
E["happy"] = body(-2) + shift(EYES_HAPPY, -2) + dot(13, -5) + SPARKS
E["laughing"] = body(-2) + shift(EYES_HAPPY + MOUTH, -2) + dot(14, -6) + SPARKS + [(-4, -5, C), (17, 6, C)]
E["funny"] = body(-1) + shift([(4, 3, C), (5, 4, C), (4, 5, C), (8, 3, C), (7, 4, C), (8, 5, C)] + MOUTH, -1) + [(-1, 2, T), (-1, 3, T), (13, 2, T), (13, 3, T)] + dot(13, -4)
E["sad"] = body(1) + shift([(5, 5, C), (7, 5, C), (6, 6, M)], 1) + dot(14, 13) + [(13, 16, M)]
E["angry"] = body() + [(4, 3, R), (5, 4, R), (8, 3, R), (7, 4, R), (5, 6, C), (6, 6, C), (7, 6, C)] + [(13, -2, R), (14, -3, R), (13, -4, R), (16, -2, R), (17, -3, R), (16, -4, R)] + dot(13, 1, R)
E["crying"] = body() + EYES_CLOSED + [(5, 6, T), (7, 6, T), (3, 8, T), (9, 9, T), (2, 11, T), (10, 12, T)] + dot(13, 12)
E["loving"] = body(-1) + shift([(5, 4, R), (7, 4, R), (5, 5, R), (7, 5, R)] + BLUSH, -1) + heart(13, -3) + heart(16, -6) + heart(-4, -1)
E["embarrassed"] = body() + EYES_DOWN + [(4, 6, R), (8, 6, R)] + [(13, -1, T), (13, 0, T), (14, 1, T), (13, 1, T)] + dot(9, 12)
E["surprised"] = body(-1) + shift(EYES_WIDE + [(6, 6, C)], -1) + at(STAR, 14, -5) + dot(13, 0)
E["shocked"] = body(-1) + shift(EYES_WIDE + [(6, 6, C)], -1) + [(14, -6, A), (14, -5, A), (14, -4, A), (14, -2, A)] + dot(15, -1) + [(-3, 1, M), (-4, 3, M), (-3, 5, M)]
E["thinking"] = body() + EYES_UP + dot(13, -4) + [(12, -1, T), (11, 0, T)]
E["winking"] = body() + [(5, 4, C), (5, 5, C), (7, 5, C), (8, 5, C)] + at(STAR, 14, -3) + dot(13, 1)
E["cool"] = body() + [(4, 4, D), (5, 4, D), (6, 4, D), (7, 4, D), (8, 4, D), (4, 5, D), (5, 5, D), (7, 5, D), (8, 5, D), (6, 6, C), (7, 6, C)] + dot(13, 12)
E["relaxed"] = body() + EYES_CLOSED + BLUSH + [(6, 6, C)] + dot(9, 13) + [(14, -2, M), (15, -3, M), (16, -2, M), (17, -3, M)]
E["delicious"] = body() + EYES_HAPPY + [(5, 6, C), (6, 6, R), (7, 6, C)] + dot(13, 9) + [(17, 7, C)]
E["kissy"] = body() + EYES_CLOSED + [(6, 6, R)] + heart(13, -2) + heart(16, -5)
E["confident"] = body() + [(4, 5, C), (5, 5, C), (7, 5, C), (8, 5, C), (4, 4, C), (8, 4, C), (6, 6, C), (7, 6, C)] + at(STAR, 14, -4) + dot(13, 0)
E["sleepy"] = body(squash=True) + shift(EYES_CLOSED, 1) + [(12 + x, -1 + y, T) for x, y in Z] + [(15 + x, -4 + y, D) for x, y in Z]
E["silly"] = body() + [(4, 4, C), (5, 4, C), (4, 5, C), (5, 5, C), (7, 5, C), (5, 6, C), (6, 6, R), (7, 6, C), (6, 7, R)] + dot(14, 10)
E["confused"] = body() + [(5, 4, C), (5, 5, C), (7, 5, C), (8, 5, C)] + [(14, -5, A), (15, -6, A), (16, -5, A), (16, -4, A), (15, -3, A), (15, -1, A)] + dot(13, 8)


def render(cells):
    gw, gh = X1 - X0 + 1, Y1 - Y0 + 1
    grid = [[(0, 0, 0, 0)] * gw for _ in range(gh)]
    for x, y, c in cells:
        gx, gy = x - X0, y - Y0
        assert 0 <= gx < gw and 0 <= gy < gh, (x, y)
        grid[gy][gx] = c
    w, h = gw * SCALE, gh * SCALE
    raw = bytearray()
    for gy in range(gh):
        row = bytearray(b"\x00")
        for gx in range(gw):
            row += bytes(grid[gy][gx]) * SCALE
        raw += bytes(row) * SCALE

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    return png, w, h


os.makedirs(OUT, exist_ok=True)
for name, cells in E.items():
    png, w, h = render(cells)
    with open(os.path.join(OUT, f"{name}.png"), "wb") as f:
        f.write(png)
print(len(E), "emotions", f"{w}x{h}")
