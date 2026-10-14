# pi-buddy 协议 v1.1

桥接程序是唯一的服务端。pi 等智能体的插件通过本机 HTTP 把状态、审批和任务轮询交给桥接程序；实战派设备（或网页模拟器）作为客户端，经 WebSocket 连上同一进程。睡眠不在协议里传输，由设备自己判断。

v1.1 在 v1 上增加配对，向后兼容。已经持有 token 的设备仍然直接发送 `hello`。网页模拟器从本机打开 `/sim` 时拿到 token，不显示配对码，也不发送 `pair_request`。mDNS 的 TXT 记录仍是 `v=1`。可选字段 `project`（这次请示来自哪个目录）和 `permission_reply` 的 `via`（`touch`、`button`、`voice`）也记在这一版里；缺省时行为和以前相同。旧设备忽略不认识的字段。

## 传输

- 默认监听 `0.0.0.0:4317`（IPv4）。可用环境变量 `PI_BUDDY_PORT` 改端口。
- 插件请使用 `http://127.0.0.1:4317`。只接受来自 `127.0.0.1` 和 `::1` 的插件请求；运行环境把 IPv4 回环报成 `::ffff:127.0.0.1` 时同样视为本机。其他地址返回 `403 {"error":"forbidden"}`。
- `GET /sim` 以及插件接口 `POST /v1/event`、`POST /v1/permission`、`POST /v1/pair`、`GET /v1/tasks` 还要检查 `Host`。主机名必须是 `127.0.0.1`、`localhost` 或 `[::1]`，端口不限；缺失或其他主机名返回 `403 {"error":"forbidden"}`。这样可以挡住 DNS 重绑定：恶意域名即便解析到 `127.0.0.1`，浏览器仍会带上那个域名的 `Host`，读不到模拟器里的 token，也不能调用插件接口。
- `POST /v1/event`、`POST /v1/permission` 和 `POST /v1/pair` 的 `Content-Type` 必须是 `application/json`，可以带 `charset` 参数（例如 `application/json; charset=utf-8`）。其他类型，包括浏览器跨站简单请求常用的 `text/plain`，返回 `415 {"error":"unsupported_media_type"}`，正文不会被处理。
- 设备 WebSocket 路径：`/v1/device`。局域网设备可以连接，不经过插件的回环限制。没有 `Origin` 时仍只做 token 认证（实战派固件不发送 `Origin`）。如果带了 `Origin`（浏览器一定会带），其主机名同样必须是 `127.0.0.1`、`localhost` 或 `[::1]`，否则在握手阶段拒绝，响应 `403`，连接不会建立。网页模拟器从上述主机名打开时，浏览器带上的 `Origin` 可以通过。
- 每条 WebSocket 消息都是 JSON 对象，并且带字符串字段 `type`。

## 发现

桥接程序用 mDNS 广播服务类型 `_pibuddy._tcp`（实例名 `pi-buddy`）。TXT 记录包含 `v=1`。

## 认证

首次启动时，桥接程序生成随机 token，写入 `~/.pi-buddy/config.json`（文件权限 `600`，目录权限 `700`）。`PI_BUDDY_HOME` 可以改这个目录。命令 `pi-buddy-bridge token` 打印 token。

设备连上 `/v1/device` 后，第一条消息可以是 `hello`（已经有 token），也可以是 `pair_request`（还没有 token）。尚未通过 hello 的连接不算「设备在线」。

已经有 token 时，必须在 5 秒内发送 `hello`，并且 token 正确，否则连接被断开：

- token 错误、版本不对或字段缺失：关闭码 `1008`
- 5 秒内没有完成 hello：关闭码 `4000`

### 配对

还没有 token 的设备先发送 `pair_request`。`code` 由设备随机生成，是恰好 6 位的数字字符串，可以有前导 0。

```json
{"type":"pair_request","v":1,"device_id":"<id>","code":"123456"}
```

- `v` 必须为 `1`。
- `device_id` 为非空字符串。
- `code` 必须匹配 `^[0-9]{6}$`。

字段不合法时关闭码 `1008`（原因 `bad pair request`）。`pair_request` 只能作为认证前的第一条消息，同一条连接只接受一次。

桥接程序记下这条待配对请求：

- 最多保留 5 分钟。发了 `pair_request` 的连接不再适用 5 秒 hello 限制，改为 5 分钟内必须完成后面的 `hello`，否则关闭码 `4000`。这 5 分钟从 `pair_request` 到达时起算，收到 `pair_ok` 后不重新计时。
- 同时最多 3 条。第 4 条到达时，拒绝最早的那一条：把它从待配对列表去掉，并关闭它的连接（关闭码 `1008`，原因 `pair queue full`）。新的这一条被记下。
- 连接断开时删掉对应的请求。通过 `hello` 之后，这条连接上若还留着待配对请求，也删掉。
- 连续错误把待配对列表清空时，只删请求，不断开连接。这些连接仍然要在原来的 5 分钟内发送 `hello`；它们的配对码已经作废，需要重新连接才能再发 `pair_request`。

用户在 Mac 上确认屏幕上的配对码。

`POST /v1/pair`

```json
{"code":"123456"}
```

`code` 必须是字符串。本机访问、`Host` 和 `Content-Type` 的规则与其他插件接口相同。命令 `pi-buddy-bridge pair <code>` 向 `http://127.0.0.1:<端口>/v1/pair` 发送这个请求（端口默认 `4317`，可用 `PI_BUDDY_PORT` 修改）。成功时把响应正文打到标准输出；失败时把响应正文打到标准错误，并以非 0 退出。桥接程序没在监听时，命令行会说明连不上。

- 有待配对请求的 `code` 与之相同，且那条连接仍开着：向那条连接发送 `pair_ok`，该请求被消耗，并返回 `200 {"device_id":"<id>"}`。`device_id` 来自对应的 `pair_request`。多条码相同时，配对最早记下的一条。成功后连续错误计数清零。
- 没有对上：`404 {"error":"not_found"}`。连续 5 次这样的失败后，清空所有待配对请求，连续错误计数回到 0。中间一旦配对成功，计数也回到 0，之后再重新累计。
- `code` 缺失或不是字符串：`400 {"error":"bad_request"}`。这次不计入上面的连续 5 次。

设备收到 `pair_ok` 后，在同一条连接上发送 `hello` 完成认证。`hello` 的校验与下面相同。

#### 桥接程序 → 设备

`pair_ok`

```json
{"type":"pair_ok","token":"<token>"}
```

`token` 就是桥接程序配置里的那一个 token，不是按设备另发的新 token。

### 设备 → 桥接程序

`hello`

```json
{"type":"hello","v":1,"token":"<token>","device_id":"<id>","fw":"<firmware>","board":"<board>"}
```

`v` 必须为 `1`。`token` 与 `device_id` 为非空字符串。`fw` 和 `board` 为字符串，可以为空。

### 桥接程序 → 设备

`hello_ack`

```json
{"type":"hello_ack","v":1,"bridge_version":"0.1.0"}
```

`bridge_version` 是桥接程序的版本号。通过认证后，桥接程序立刻再发一条当前的 `state`；如果当时有一条正在显示的审批，还会补发对应的 `permission`。

## 插件：状态

`POST /v1/event`

```json
{"source":"pi","session":"<session>","state":"idle","detail":""}
```

- `source`、`session`：非空字符串。`source` 是插件名，例如 `pi`。
- `state`：`idle`、`thinking`、`working`、`done`、`error` 之一。
- `detail`：字符串。缺省视为 `""`。

成功返回 `200 {"ok":true}`。字段不合法返回 `400 {"error":"bad_request"}`。同一 `source` + `session` 的后一次事件覆盖前一次。

桥接程序只向设备发送汇总后的状态，不把每个会话原样转发。多个会话按下面的优先级取一个：

`permission` > `error` > `working` > `thinking` > `done` > `idle`

优先级相同的时候，取最近一次更新的会话。没有任何会话、也没有审批时，汇总为 `idle`，`detail` 为空字符串。

`permission` 不是插件能上报的会话状态。只要有一条审批正在设备上显示（或还排在它后面），汇总状态就是 `permission`，`detail` 为正在显示的那条审批的 `summary`。

### 桥接程序 → 设备

`state`

```json
{
  "type": "state",
  "state": "working",
  "detail": "bash · npm test",
  "sessions": [
    {"source": "pi", "session": "demo", "state": "working", "detail": "bash · npm test"}
  ]
}
```

`sessions` 是当前已知会话的列表，顺序为更新顺序。它不包含一条伪造的 `permission` 会话。

## 插件：审批

`POST /v1/permission`

```json
{"source":"pi","session":"<session>","tool":"bash","summary":"rm -rf dist","timeout_s":120}
```

- `source`、`session`：非空字符串。
- `tool`、`summary`：字符串，可以为空。
- `timeout_s`：大于 0 且不超过 86400 的有限数字，从这条审批**开始在设备上显示**时起算。同一时间设备只显示一条，其余排队；排队期间不计时，避免还没轮到就被超时。
- `project`：可选。字符串，最长 32 个 Unicode 码点。用来标明这次请示来自哪个项目。pi 插件填当前工作目录的最后一级目录名；超过 24 个码点时保留前 24 个并在末尾加上 `…`。缺省、不是字符串、或超过 32 个码点时，桥接程序丢掉这个字段，审批照常进行。合法值（包括空字符串）原样放进发给设备的 `permission`。旧设备忽略不认识的字段即可。

请求会挂起，直到可以返回：

```json
{"decision":"allow"}
```

`decision` 为 `allow`、`deny`、`timeout`、`no_device` 之一。设备回复里若带了合法的 `via`，响应里一并带上，例如 `{"decision":"deny","via":"voice"}`。没有合法 `via` 时响应里不出现这个字段。

- 收到请求时没有已通过 hello 的设备：立刻返回 `no_device`，插件应退回终端确认。
- 设备在等待期间断开，并且已经没有任何在线设备：所有挂起的审批（正在显示的和排队的）立刻返回 `no_device`。
- 显示时间超过 `timeout_s`：该条返回 `timeout`。
- 插件在收到响应前断开这条 HTTP 请求：视为插件端取消。桥接程序不再写响应正文。

字段不合法时返回 `400`，即使当前没有设备。

### 桥接程序 → 设备

`permission`：当前要显示的那一条。

```json
{
  "type": "permission",
  "id": "<uuid>",
  "source": "pi",
  "tool": "bash",
  "summary": "rm -rf dist",
  "timeout_s": 120,
  "queue_len": 1,
  "project": "pi-buddy"
}
```

`queue_len` 是还在排队、尚未显示的条数，不含正在显示的这一条。后面又有新请求排入时，桥接程序会用同一个 `id` 再发一条 `permission`，只为更新 `queue_len`。设备应按 `id` 更新，不要当成新的一条。`project` 只在插件传来了合法值时出现，内容和插件发来的相同；没有这个字段时不要当成空项目名。旧设备忽略它即可。`timeout_s` 的单位是秒，和插件请求里的数字相同。插件默认发送 `120`，桥接程序按这个秒数计时，到点发送 `permission_cancel`（`reason` 为 `timeout`）。

`permission_cancel`

```json
{"type":"permission_cancel","id":"<uuid>","reason":"timeout"}
```

`reason`：

- `timeout`：显示超时
- `cancelled`：插件端取消（HTTP 请求已断开）

设备做出决定后不再发 `permission_cancel`，桥接程序改为发送新的 `state`（如果队列里还有下一条，则紧接着发下一条 `permission`）。

### 设备 → 桥接程序

`permission_reply`

```json
{"type":"permission_reply","id":"<uuid>","decision":"allow","via":"touch"}
```

`decision` 只能是 `allow` 或 `deny`。`id` 必须是当前正在显示的那一条；其他回复被忽略。有多台设备同时在线时，先到达的有效回复生效。

`via` 可选，表示这次决定是怎么做出的：

- `touch`：屏幕上点的「允许」或「拒绝」
- `button`：BOOT 键（按住 1 秒允许，短按拒绝）
- `voice`：语音

缺省视为未知。值不是这三个字符串时，桥接程序忽略 `via`，回复仍然有效。日志会打印这次回复的 via，未知记为 `unknown`。`POST /v1/permission` 的响应在 `via` 合法时带上它；没有合法 `via` 时响应里不出现这个字段。pi 插件在 `via` 为 `voice` 且决定是拒绝时，原因是「用户在 P 仔上用语音拒绝了这条命令，命令没有执行」；其他来源（包括未知、`touch`、`button`）仍是「用户在 P 仔上拒绝了这条命令，命令没有执行」。允许和超时不因 `via` 改文案。

## 插件：语音任务

设备可以把一句话派回给插件。任务不按 `source` 拆队列：语音任务只有一份，全局按到达顺序保存。

### 设备 → 桥接程序

`task`

```json
{"type":"task","text":"跑一下测试"}
```

`text` 为非空字符串。空文本被忽略。

### 插件 → 桥接程序

`GET /v1/tasks?source=pi`

`source` 查询参数必填（非空），用来标识发起轮询的插件，但不决定任务发给谁。

- 队列里已有任务：立刻 `200 {"text":"..."}`，每次返回最早的一条。
- 否则挂起，最多 30 秒。期间有任务到达就返回 `200 {"text":"..."}`。
- 超时：`204`，没有正文。
- 多个挂起的长轮询按先后各取一条。

## 设备输入

`input` 先只记日志，不改变状态，也不产生插件响应。

```json
{"type":"input","kind":"button_short"}
```

`kind`：`button_short`、`button_long`、`touch`、`tap`。其他值也只记一条未知输入日志。

## 断线

- 设备断开后，如果已经没有通过认证的设备，所有挂起审批立刻返回 `no_device`。
- 只断开其中一台、仍有其他设备在线时，审批继续等待。
- 尚未通过 hello 的连接断开，不影响审批。如果它还有待配对请求，该请求一并删除，之后再用这个配对码调用 `/v1/pair` 会得到 `404`。

## 睡眠

「睡着了」（`sleep`）由设备本地判断：汇总状态为 `idle`、且没有正在显示的审批时，闲置 5 分钟进入睡眠。桥接程序不发送 `sleep`。任何新的 `state` 或 `permission` 都会把设备叫醒。网页模拟器在画面上点击一次也会从睡眠回到当前状态，并向桥接程序发送 `input` / `touch`。

模拟器默认就是这 5 分钟。打开 `http://127.0.0.1:4317/sim?sleep_ms=<毫秒>` 可以改成本地预览用的闲置时间，不改变协议。

## 网页模拟器

`GET /sim` 返回模拟器页面。`Host` 不是本机名时直接 `403`。`Host` 合法且连接来自回环地址时，页面里才会带上设备 token，页面随即以设备身份连接 `/v1/device`（`device_id` 形如 `web-sim-…`，`fw` 为 `sim`，`board` 为 `web`）。请用 `http://127.0.0.1:4317/sim`、`http://localhost:4317/sim` 或 `http://[::1]:4317/sim` 打开。

画面是 320×240 的 canvas，CSS 显示为 640×480（2 倍），`image-rendering: pixelated`，像素不插值。形象与 `assets/mascot/draw.py` 一致：网格 `S=7`，原点 `(112, 44)`，七种状态为 `idle`、`thinking`、`working`、`permission`、`done`、`error`、`sleep`。状态栏在 `y=196`，左侧 4 像素为当前状态的强调色。中文使用系统无衬线字体。

状态栏的 `detail` 使用桥接程序发来的 `detail`。`permission` 时改为显示 `tool`、`summary`，以及「BOOT：按住允许，短按拒绝」。页面上的「允许（按住 BOOT）」和「拒绝（短按 BOOT）」发送 `permission_reply`，并带 `via` 为 `touch`。有项目名时，画面左上角显示「项目名 · 剩余秒数」，剩余秒数从这条 `permission` 第一次出现开始按 `timeout_s` 倒数；同一个 `id` 再次到来（只为更新 `queue_len`）不重置倒计时。没有项目名时左上角只显示剩余秒数。输入框发送 `task`。
