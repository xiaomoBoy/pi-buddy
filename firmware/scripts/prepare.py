#!/usr/bin/env python3
"""把 pi-buddy 板型叠加到小智 subtree 上（幂等，可以重复执行）。

做三件事：
1. 把 firmware/boards/pibuddy-szp-s3/ 拷到 firmware/xiaozhi/main/boards/pibuddy/szp-s3/。
2. 在小智的 main/CMakeLists.txt 和 main/Kconfig.projbuild 里注册板型。
3. 给自定义唤醒词加一个钩子：action 不是 wake 的命令词（语音审批）交给板型处理。

改动只发生在工作区，提交前用 `git checkout firmware/xiaozhi` 还原，subtree 保持与上游一致。
升级小智后如果锚点找不到，脚本会报错退出，按报错位置更新下面的锚点即可。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XIAOZHI = ROOT / "xiaozhi"
MAIN = XIAOZHI / "main"
SRC = ROOT / "boards" / "pibuddy-szp-s3"
DST = MAIN / "boards" / "pibuddy" / "szp-s3"
SYMBOL = "BOARD_TYPE_PIBUDDY_SZP_S3"


def insert_after(path: Path, anchor: str, text: str, marker: str) -> None:
    body = path.read_text(encoding="utf-8")
    if marker in body:
        return
    if anchor not in body:
        sys.exit(f"找不到锚点，无法注册板型：{path}\n  {anchor!r}")
    path.write_text(body.replace(anchor, anchor + text, 1), encoding="utf-8")


def add_to_depends(path: Path, anchor: str) -> None:
    """在已经列出实战派的 depends 表达式里追加本板型。"""
    body = path.read_text(encoding="utf-8")
    new = anchor.replace("BOARD_TYPE_LICHUANG_DEV_S3", f"BOARD_TYPE_LICHUANG_DEV_S3 || {SYMBOL}")
    if new in body:
        return
    if anchor not in body:
        sys.exit(f"找不到锚点：{path}\n  {anchor!r}")
    path.write_text(body.replace(anchor, new, 1), encoding="utf-8")


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST)

    insert_after(
        MAIN / "CMakeLists.txt",
        'elseif(CONFIG_BOARD_TYPE_LICHUANG_DEV_S3)\n'
        '    set(BOARD_DIR "lckfb/szpi-esp32s3")\n'
        '    set(BUILTIN_TEXT_FONT font_noto_sans_basic_20_4)\n'
        '    set(BUILTIN_ICON_FONT font_material_symbols_20_4)\n'
        '    set(DEFAULT_EMOJI_COLLECTION noto-color-emoji_128)\n',
        f'elseif(CONFIG_{SYMBOL})\n'
        '    set(BOARD_DIR "pibuddy/szp-s3")\n'
        '    set(BUILTIN_TEXT_FONT font_noto_sans_basic_20_4)\n'
        '    set(BUILTIN_ICON_FONT font_material_symbols_20_4)\n'
        '    set(DEFAULT_EMOJI_COLLECTION noto-color-emoji_128)\n',
        f"CONFIG_{SYMBOL}",
    )
    insert_after(
        MAIN / "Kconfig.projbuild",
        '    config BOARD_TYPE_LICHUANG_DEV_S3\n'
        '        bool "LCKFB SZPI ESP32-S3 (立创·实战派)"\n'
        '        depends on IDF_TARGET_ESP32S3\n',
        f'    config {SYMBOL}\n'
        '        bool "pi-buddy on LCKFB SZPI ESP32-S3（P 仔）"\n'
        '        depends on IDF_TARGET_ESP32S3\n',
        f"config {SYMBOL}",
    )
    # 设备端回声消除、表情风格这两处 depends 列表里有实战派，本板型同样适用
    add_to_depends(MAIN / "Kconfig.projbuild", "|| BOARD_TYPE_ESP_VOCAT || BOARD_TYPE_LICHUANG_DEV_S3 || BOARD_TYPE_RYMCU_BIGSMART")
    add_to_depends(MAIN / "Kconfig.projbuild", "        || BOARD_TYPE_LICHUANG_DEV_S3 || BOARD_TYPE_RYMCU_BIGSMART || BOARD_TYPE_ESP32_S3_KORVO_2_V3")
    # 小智只处理 action 为 wake 的命令词，其他的直接忽略；这里转给板型（弱符号，别的板型不受影响）
    wake_word = MAIN / "audio" / "wake_words" / "custom_wake_word.cc"
    insert_after(
        wake_word,
        '#define TAG "CustomWakeWord"\n',
        '\n// pi-buddy：不是 wake 的命令词交给板型处理（由 firmware/scripts/prepare.py 叠加）\n'
        'extern "C" void pibuddy_on_voice_command(const char* action, float prob) __attribute__((weak));\n',
        "pibuddy_on_voice_command(const char* action",
    )
    insert_after(
        wake_word,
        '                    if (wake_word_detected_callback_) {\n'
        '                        wake_word_detected_callback_(last_detected_wake_word_);\n'
        '                    }\n'
        '                }',
        ' else if (pibuddy_on_voice_command) {\n'
        '                    pibuddy_on_voice_command(command.action.c_str(), mn_result->prob[i]);\n'
        '                }',
        "pibuddy_on_voice_command(command.action",
    )
    print(f"已叠加板型：{DST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
