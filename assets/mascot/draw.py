"""P 仔概念稿：基于《Pi 蓝皮书》logo（米白 P + 青蓝圆点）的像素小人，7 种状态的 320x240 屏幕模拟。"""
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
BG = (0x26, 0x31, 0x3A)      # logo 底色：深石板蓝
CREAM = (0xF8, 0xF5, 0xED)   # logo 的 P
TEAL = (0x4F, 0x90, 0xAA)    # logo 的圆点
DEEP = (0x27, 0x6D, 0x89)    # 蓝皮书封面强调色
MUTED = (0xA9, 0xB0, 0xB5)   # 封面次要文字
AMBER = (0xF1, 0xBE, 0x58)   # 请示时的提醒色
CORAL = (0xE5, 0x64, 0x5A)   # 出错
BAR = (0x1C, 0x24, 0x2B)     # 底部状态栏

S = 7                        # 每个像素格的大小
OX, OY = 112, 44             # 角色网格原点（屏幕坐标）

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


def cells_from(rows, ch):
    return [(x, y) for y, r in enumerate(rows) for x, c in enumerate(r) if c == ch]


P_CELLS = cells_from(P_ROWS, "#")
DOT_CELLS = cells_from(DOT, "o")


def px(d, x, y, color, dx=0, dy=0):
    X, Y = OX + (x + dx) * S, OY + (y + dy) * S
    d.rectangle([X, Y, X + S - 1, Y + S - 1], fill=color)


def body(d, dy=0, squash=False):
    for x, y in P_CELLS:
        if squash and y >= 10:          # 落地压扁：腿变短
            if y == 15:
                continue
        px(d, x, y, CREAM, dy=dy + (1 if squash and y < 10 else 0))


def dot(d, x, y, color=TEAL, small=False):
    if small:
        for cx, cy in [(0, 0), (1, 0), (0, 1), (1, 1)]:
            px(d, x + cx, y + cy, color)
        return
    for cx, cy in DOT_CELLS:
        px(d, x + cx, y + cy, color)


def eyes(d, kind, dy=0):
    # 眼睛画在 P 的“洞”里（x 4..8, y 3..6），像头盔面罩里的脸
    if kind == "open":
        for x in (5, 7):
            px(d, x, 4, CREAM, dy=dy); px(d, x, 5, CREAM, dy=dy)
    elif kind == "up":
        for x in (5, 7):
            px(d, x, 3, CREAM, dy=dy); px(d, x, 4, CREAM, dy=dy)
    elif kind == "down":
        for x in (5, 7):
            px(d, x, 5, CREAM, dy=dy); px(d, x, 6, CREAM, dy=dy)
    elif kind == "wide":
        for x0 in (4, 7):
            for cx in (0, 1):
                for cy in (3, 4):
                    px(d, x0 + cx, cy + 1, CREAM, dy=dy)
    elif kind == "happy":
        for x0 in (4, 7):
            px(d, x0, 5, CREAM, dy=dy); px(d, x0 + 1, 4, CREAM, dy=dy); px(d, x0 + 2, 5, CREAM, dy=dy)
    elif kind == "x":
        for x0 in (4, 7):
            for cx, cy in [(0, 0), (2, 0), (1, 1), (0, 2), (2, 2)]:
                px(d, x0 + cx, 3 + cy, CORAL, dy=dy)
    elif kind == "closed":
        for x0 in (4, 7):
            px(d, x0, 5, CREAM, dy=dy); px(d, x0 + 1, 5, CREAM, dy=dy)


def text(d, xy, s, size, color, bold=False):
    font = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc", size)
    d.text(xy, s, font=font, fill=color)


def screen(state):
    im = Image.new("RGB", (320, 240), BG)
    d = ImageDraw.Draw(im)
    status, detail, accent = "", "", MUTED

    if state == "idle":
        body(d); eyes(d, "open"); dot(d, 8, 12)
        status, detail = "待机", "pi 在等你的下一个任务"
    elif state == "thinking":
        body(d); eyes(d, "up")
        dot(d, 13, -4)
        px(d, 12, -1, TEAL); px(d, 11, 0, TEAL)      # 思考气泡的小尾巴
        status, detail, accent = "思考中", "turn 3 · deepseek-v4-flash", TEAL
    elif state == "working":
        body(d); eyes(d, "down")
        dot(d, 9, 13, small=True)                    # 圆点在敲键盘
        for i in range(8):                           # 键盘
            px(d, 5 + i, 16, MUTED if i % 2 == 0 else DEEP)
        status, detail, accent = "干活中", "bash · npm test", TEAL
    elif state == "permission":
        body(d); eyes(d, "wide")
        for y in range(-1, 3):
            px(d, 12, y, TEAL)                        # 举起的“手臂”
        dot(d, 11, -5, color=AMBER)
        status, detail, accent = "请示：可以执行吗？", "rm -rf dist   短按 BOOT 允许 · 长按拒绝", AMBER
    elif state == "done":
        body(d, dy=-3); eyes(d, "happy", dy=-3)
        dot(d, 13, -5)
        for x, y in [(-3, -2), (15, 2), (-2, 6), (16, -2), (14, -7)]:
            px(d, x, y, CREAM)
        status, detail, accent = "完成", "3 个文件已修改 · 用时 42 秒", CREAM
    elif state == "error":
        body(d); eyes(d, "x")
        dot(d, 15, 12)                                # 圆点滚走了
        px(d, 13, 15, MUTED)
        status, detail, accent = "出错了", "npm test 失败：2 个用例未通过", CORAL
    elif state == "sleep":
        body(d, squash=True); eyes(d, "closed", dy=1)
        for i, (x, y) in enumerate([(12, -1), (15, -4)]):
            z = [(0, 0), (1, 0), (2, 0), (1, 1), (0, 2), (1, 2), (2, 2)]
            for cx, cy in z:
                px(d, x + cx, y + cy, TEAL if i == 0 else DEEP)
        status, detail = "睡着了", "闲置 5 分钟 · 摸一下屏幕叫醒"

    d.rectangle([0, 196, 319, 239], fill=BAR)
    d.rectangle([0, 196, 3, 239], fill=accent)
    text(d, (14, 200), status, 15, accent, bold=True)
    text(d, (14, 220), detail, 11, MUTED)
    text(d, (262, 6), "P. pi", 11, MUTED)
    return im


STATES = ["idle", "thinking", "working", "permission", "done", "error", "sleep"]
tiles = [screen(s).resize((640, 480), Image.NEAREST) for s in STATES]
cols, gap = 4, 24
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cols * 640 + (cols + 1) * gap, rows * 480 + (rows + 1) * gap), (0xF3, 0xF0, 0xE8))
for i, t in enumerate(tiles):
    r, c = divmod(i, cols)
    sheet.paste(t, (gap + c * (640 + gap), gap + r * (480 + gap)))
# 第 8 格放原版 logo 对照
logo = Image.open(sys.argv[2]).convert("RGB").resize((400, 400), Image.LANCZOS)
sheet.paste(logo, (gap + 3 * (640 + gap) + 120, gap + 1 * (480 + gap) + 40))
sheet.save(OUT)
print("saved", OUT, sheet.size)
