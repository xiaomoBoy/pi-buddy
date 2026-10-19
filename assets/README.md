# assets

P 仔形象与音效素材。

- `mascot/draw.py`：P 仔七种状态的权威绘制参考（320×240）
- `mascot/gen_emoji.py`：P 仔 21 个表情（156×168 PNG），给小智对话界面用
- `build_assets.py`：打包 assets 分区（表情、配色、离线命令词“你好 PI”“允许执行”“拒绝”“不要执行”）
- `tools/`：assets.bin 和 srmodels.bin 的打包、解包脚本

## 打包 assets 分区

需要一个小智 v2.5.x 的 assets.bin 当底包，里面要有中文命令词模型 mn7_cn（字体和语音模型沿用底包）。小智官方发布的 assets 只有唤醒词模型，不能直接用；可以用 [xiaozhi-claude-pixel](https://github.com/xiaomoBoy/xiaozhi-claude-pixel) 的 `bin/assets_claude_mn7.bin`，v1.1 Release 里的 `assets-pibuddy.bin` 就是用它打的。底包不对时脚本会报错退出：

```bash
python3 assets/build_assets.py <底包 assets.bin> build/assets_pibuddy.bin
esptool --chip esp32s3 -p /dev/cu.usbmodem* -b 921600 write-flash 0x800000 build/assets_pibuddy.bin
```

改命令词就改 `build_assets.py` 里的 `COMMANDS`。`action` 是 `wake` 的是唤醒词，`pibuddy_allow`、`pibuddy_deny` 由固件处理，只在屏幕上有请示时生效。
