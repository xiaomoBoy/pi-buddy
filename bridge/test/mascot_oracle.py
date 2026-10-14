"""Render one mascot state from assets/mascot/draw.py with status text disabled.

Usage: python3 mascot_oracle.py <state>
Exit 2 when Pillow is not installed. Writes raw RGB (320*240*3) to stdout.
"""

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont  # noqa: F401
except ImportError:
    raise SystemExit(2)

if len(sys.argv) != 2:
    raise SystemExit("usage: mascot_oracle.py <state>")

state = sys.argv[1]
root = Path(__file__).resolve().parents[2]
src = (root / "assets" / "mascot" / "draw.py").read_text(encoding="utf-8")
src = src.split("\nSTATES = ", 1)[0]
sys.argv = ["draw.py", "unused", "unused"]
namespace: dict[str, object] = {"__name__": "draw"}
exec(compile(src, str(root / "assets" / "mascot" / "draw.py"), "exec"), namespace)


def _text(d, xy, s, size, color, bold=False):
    return None


namespace["text"] = _text
screen = namespace["screen"]
image = screen(state)
sys.stdout.buffer.write(image.tobytes())
