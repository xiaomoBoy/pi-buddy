"""打包 P 仔的 assets 分区（表情、配色、离线命令词），刷到 0x800000。

用法：build_assets.py <底包 assets.bin> <输出.bin>

底包要求：小智 v2.5.x 的 assets.bin，srmodels 里带 mn7_cn（中文命令词模型）。
字体和语音模型沿用底包，表情由 mascot/gen_emoji.py 重新生成，index.json 里的
配色和命令词按下面的常量改写。刷机：
  esptool --chip esp32s3 -p /dev/cu.usbmodem* -b 921600 write-flash 0x800000 <输出.bin>
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import pack  # noqa: E402
import unpack  # noqa: E402

SKIN = {"text_color": "#F8F5ED", "background_color": "#26313A"}

# action 不是 wake 的命令词由固件的 AgentChannel 处理，只在屏幕上有请示时才生效。
# “允许”用四个字的长词减少误触发；“拒绝”误触发只会拦下命令，用短词也没关系。
COMMANDS = [
    {"command": "ni hao pai", "text": "你好PI", "action": "wake"},
    {"command": "yun xu zhi xing", "text": "允许执行", "action": "pibuddy_allow"},
    {"command": "ju jue", "text": "拒绝", "action": "pibuddy_deny"},
    {"command": "bu yao zhi xing", "text": "不要执行", "action": "pibuddy_deny"},
]


def main(base, out):
    with tempfile.TemporaryDirectory() as tmp:
        files = os.path.join(tmp, "files")
        unpack.unpack(base, files)
        index_path = os.path.join(files, "index.json")
        index = json.load(open(index_path, encoding="utf-8"))
        if "srmodels" not in index or index.get("multinet_model", {}).get("language") not in (None, "cn"):
            sys.exit("底包里没有中文 multinet 模型（srmodels + multinet_model）")

        subprocess.run([sys.executable, os.path.join(HERE, "mascot", "gen_emoji.py"), files], check=True)
        index["skin"] = {"light": SKIN, "dark": SKIN}
        multinet = index.setdefault("multinet_model", {"language": "cn", "duration": 3000, "threshold": 0.2})
        multinet["commands"] = COMMANDS
        json.dump(index, open(index_path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

        dims_path = os.path.join(tmp, "files.dims.json")
        dims = json.load(open(dims_path)) if os.path.exists(dims_path) else None
        count, size = pack.pack(files, out, dims)
    print(f"{out}: {count} 个文件，{size} 字节")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
