# firmware

固件：小智 AI（78/xiaozhi-esp32 v2.5.2）的 git subtree，加上 pi-buddy 自定义板型 `pibuddy-szp-s3`（立创实战派 ESP32-S3）。

## 目录

| 路径 | 内容 |
|---|---|
| `xiaozhi/` | 小智 subtree，不直接改，升级方法见 `docs/upstream.md` |
| `boards/pibuddy-szp-s3/` | 板型源码：硬件初始化沿用上游 `lckfb/szpi-esp32s3`，加了 P 仔界面、按键审批、语音派活 |
| `scripts/prepare.py` | 编译前把板型叠加进小智（拷文件 + 在 Kconfig、CMakeLists 里注册），幂等 |

板型里的文件：

| 文件 | 作用 |
|---|---|
| `pibuddy_board.cc` | 板型入口；审批：屏幕上点「允许」「拒绝」，或短按 BOOT 允许、按住 1.5 秒拒绝（请示出现前就按下的不算）；注册 MCP 工具 `self.pi.dispatch_task` |
| `agent_channel.*` | 连桥接程序（协议 v1.1）：mDNS 发现、配对、状态、审批、提示音、内存日志 |
| `buddy_screen.*` | P 仔全屏界面，画在 LVGL 顶层，形象与 `assets/mascot/draw.py` 一致 |
| `mdns_lookup.*` | 一次性的 mDNS 查询，不引入 mdns 组件 |

## 本地编译

ESP-IDF v6.1。仓库路径里不能有中文（GCC 读不了），比如放在 `~/esp/pi-buddy`。

```bash
python3 firmware/scripts/prepare.py
cd firmware/xiaozhi
. ~/esp/esp-idf-v6.1/export.sh
python scripts/build.py pibuddy/szp-s3 --name pibuddy-szp-s3   # 第一次
idf.py build                                                     # 之后改代码只需这一步
```

`prepare.py` 会改动 `firmware/xiaozhi` 的工作区，提交前还原：

```bash
git checkout -- firmware/xiaozhi && rm -rf firmware/xiaozhi/main/boards/pibuddy
```

## 刷机

已经在用的板子只刷应用，保留 NVS 里的 WiFi 和激活信息：

```bash
esptool --chip esp32s3 -p /dev/cu.usbmodem* -b 921600 write-flash 0x20000 build/xiaozhi.bin
```

`merged-binary.bin` 从 0x0 写整片 flash，会清掉 NVS，只用于全新的板子。表情和唤醒词在 assets 分区（0x800000），单独打包、单独刷。

## 注意

- 后台任务的栈放在 PSRAM，这样的任务里不能读写 flash（包括 NVS），否则断言重启。读 NVS 放在 `AgentChannel::Start()`（主任务）里，写 NVS 用 `Application::Schedule` 交给主任务。
- 内存日志 TAG 是 `pibuddy-mem`：开机、上线和之后每 60 秒打印内部内存剩余、最大连续块和 PSRAM 剩余。
- 升级小智后先跑 `prepare.py`。锚点找不到时它会报错，按报错的位置更新脚本里的锚点；再对照上游 `lichuang_dev_board.cc` 同步硬件初始化部分。
