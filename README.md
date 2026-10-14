# pi-buddy

**中文**：pi-buddy 是 [pi coding agent](https://github.com/badlogic/pi-mono) 的桌面硬件伙伴。屏幕上的吉祥物「P 仔」会跟随智能体的状态变化（思考、执行、等待、完成），你还可以直接在设备上审批智能体要执行的命令。硬件为立创实战派 ESP32-S3。

**English**: pi-buddy is a desktop hardware companion for the pi coding agent. The on-screen mascot "P-zai" reacts to the agent's state (thinking, running, waiting, done), and you can approve the agent's commands right on the device. Hardware: LCKFB SZPI ESP32-S3 (立创实战派).

## 声明 / Disclaimer

这是一个粉丝项目，与 pi、Anthropic、OpenAI 均无任何官方关系。
This is a fan project and is not affiliated with or endorsed by pi, Anthropic, or OpenAI.

固件基于 [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)（MIT License）。
The firmware is based on [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) (MIT License).

## 目录 / Layout

- `firmware/`：固件（小智 subtree 与自定义板型）/ firmware (xiaozhi subtree + custom board)
- `bridge/`：Mac 桥接程序与网页模拟器 / Mac bridge and web simulator
- `plugins/pi/`：pi 插件 / pi plugin
- `plugins/claude-code/`、`plugins/codex/`：占位，后续再做 / placeholders
- `assets/`：形象与音效 / art and sounds
- `docs/`：文档 / docs

## License

MIT
