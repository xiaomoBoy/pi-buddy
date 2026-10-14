# bridge

Mac 上的桥接程序和网页模拟器。插件只从本机访问 HTTP，设备走 WebSocket。协议见 [docs/protocol.md](../docs/protocol.md)。

需要 Node.js 22 或更新版本。

## 安装

```bash
cd bridge
npm install
```

安装时会编译 TypeScript。首次启动会在 `~/.pi-buddy/config.json` 生成 token，文件权限为 `600`。

## 启动

```bash
npm start
```

默认监听 `0.0.0.0:4317`。终端会打印模拟器地址。查看 token：

```bash
npx pi-buddy-bridge token
```

换端口可以设置 `PI_BUDDY_PORT`。换配置目录可以设置 `PI_BUDDY_HOME`。

## 打开模拟器

浏览器打开 [http://127.0.0.1:4317/sim](http://127.0.0.1:4317/sim)。

页面以设备身份自动连接。屏幕是 320×240，按 2 倍显示。闲置 5 分钟后进入睡眠，收到新状态会醒来。

## 演示

另开一个终端，在 `bridge/` 下执行：

```bash
npm run demo
```

它会按顺序发送：待机 → 思考 → 干活 → 一次审批 → 完成 → 出错 → 待机。审批会停在模拟器上，点「允许（短按 BOOT）」或「拒绝（长按 BOOT）」后继续。没有模拟器连着的时候，这次审批会立刻返回 `no_device`。

## 测试

```bash
npm run typecheck
npm test
```
