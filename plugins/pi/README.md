# plugins/pi

pi coding agent 的扩展。它把 pi 的状态同步到 P 仔，危险的 bash 命令会在设备和终端上同时请示，语音派来的任务也会送回 pi。

协议见 [docs/protocol.md](../../docs/protocol.md)。扩展由 pi 用 jiti 加载 `index.ts`，不需要单独编译。

## 本机试用

需要 Node.js 22 或更新版本，并且已经装好 [pi](https://github.com/earendil-works/pi)。

先启动桥接程序：

```bash
cd bridge
npm install
npm start
```

浏览器打开 [http://127.0.0.1:4317/sim](http://127.0.0.1:4317/sim)。页面会以设备身份连上桥接程序。

再加载这个扩展。装进 pi：

```bash
pi install ./plugins/pi
```

或者只对这一次会话生效：

```bash
pi -e ./plugins/pi
```

路径相对于你执行命令时的目录。在仓库根目录执行时用上面的 `./plugins/pi`。

语音任务只在交互式 TUI（`ctx.mode === "tui"`）里轮询。`pi -p` 这类没有界面的模式不会去拉任务。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_BUDDY_URL` | `http://127.0.0.1:4317` | 桥接程序地址。状态、审批和任务轮询都打到这里。 |
| `PI_BUDDY_APPROVAL` | `dangerous` | `off` 不拦截；`dangerous` 只拦下面列出的危险 bash；`bash` 所有 bash 都要审批。 |

桥接程序没开时，状态同步会静默失败，终端只提示一次。审批会退回终端确认；没有界面时危险命令被拦住。

## 危险命令会在 P 仔上请示

默认会拦住这些 bash 命令，并同时问 P 仔和终端，谁先回答用谁：

- `rm -r` / `rm -rf` / `rm --recursive`
- `sudo`
- `chmod` 或 `chown` 出现 `777`
- `git push --force` 或 `git push -f`
- `git reset --hard`
- `npm publish`
- `curl` 或 `wget` 用管道送给 `sh` / `bash`

P 仔上允许就放行，拒绝则不执行。等满 120 秒没有答复也会拦住。终端先回答时，设备上的那条审批会撤掉。

普通命令（例如 `ls`）不会请示。

## 测试

```bash
cd bridge && npm install
cd ../plugins/pi && npm install
npm run typecheck
npm test
```

测试会在随机端口拉起桥接程序，并用 WebSocket 模拟一台设备。
