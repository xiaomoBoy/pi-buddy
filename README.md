# pi-buddy

**中文**：pi-buddy 是 [pi coding agent](https://github.com/earendil-works/pi) 的桌面硬件伙伴。屏幕上的吉祥物「P 仔」会跟随智能体的状态变化（思考、执行、等待、完成），你还可以直接在设备上审批智能体要执行的命令。硬件为立创实战派 ESP32-S3。

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

## 快速上手

1. 启动桥接程序：

   ```bash
   cd bridge && npm install && npm start
   ```

   想开机自启就运行 `service install`（只支持 macOS）。没有全局安装时，在 `bridge/` 目录执行 `npx pi-buddy-bridge service install`，或 `node dist/cli.js service install`。`bridge/package.json` 的 `bin.pi-buddy-bridge` 指向 `./dist/cli.js`，`scripts.start` 是 `node dist/cli.js`。

2. 设备开机后，屏幕显示 6 位配对码。桥接程序已经在跑的时候，在 Mac 上配对：

   ```bash
   cd bridge && npx pi-buddy-bridge pair <配对码>
   ```

   等价写法是同一目录下的 `node dist/cli.js pair <配对码>`。

3. 加载 pi 插件（在仓库根目录）：

   ```bash
   pi -e ./plugins/pi
   ```

4. 刷固件只刷应用、不清 NVS。步骤见 [firmware/README.md](firmware/README.md)。

## 现在能做什么

- **状态同步**：P 仔跟随 pi 的思考、执行、完成和出错。
- **危险命令在 P 仔上审批**：屏幕上点「允许」「拒绝」；也可以按住 BOOT 1 秒允许、短按拒绝（按到一半松手算拒绝，请示出现前就按下的不算）。
- **语音派活**：在设备上说一句话，派回给正在开着的 pi。这一项还没真机验证。

## License

MIT
