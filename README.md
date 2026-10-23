# DeepSeek:Friend · 微信 ↔ DSH Bridge

版本 **1.6.2**。通过腾讯官方 iLink 接收微信文本和图片，由独立 DSH 内的 **DeepSeek-V41-Flash** 处理。支持一轮多条消息、持续思考、本机思考记录、小闹钟和已授权联系人的主动消息。

v1.6.2 移除网页冷静期倒计时及拦截，手机端自行处理冷静期；网页按原生状态更新，错误提示以脱敏原文显示。已在本机完成 QQ 手机扫码、OneBot 鉴权及好友/收藏列表读取，实际消息投递仍需手机验收。

**DSH 是唯一 Agent Runtime。** Bridge 不调用独立 LLM API，不执行模型工具，不实现 MCP 调度，不依赖 OpenClaw 主程序。默认只接受扫码者；其他用户必须由本地配置明确加入白名单。

v1.4.2 修复普通回复误入私有笔记、未进入微信发送队列的问题，保留后续自主思考的私密性；见 [回复路由修复](docs/incident-reply-routing.md)。

v1.4.1 修复旧会话升级后“工具全部延迟加载”导致的 Agent 异常，原会话无需重建。原因、回归与当前部署见 [修复记录](docs/incident-tool-loading.md)。

## QQ、通讯录、受限互联网与 DSF 归档

控制台新增「QQ 与通讯录」「互联网测试」「DSF 归档」三页。v1.6 已集成项目内 NapCat 网关管理与网页 QQ 二维码，支持收藏表情列表、图片查看、主动发送及把已收到图片加入收藏。使用步骤见 [网关与表情说明](docs/qq-gateway-v16.md)。

QQ 通过本机 OneBot v11 正向 WebSocket 与微信共用当前正式会话，只处理现有好友私聊。`npm run qq:setup` 可安装固定版本的项目内 NapCat Windows 网关，不修改现有桌面 QQ。首页「一键启动全部」同时启动已安装的 QQ Bot，登录成功后自动启用 QQ Bridge；微信和 QQ 二维码并列显示。真实 QQ 号 `3626097226` 是可信 OTREE，通讯录预填 `3326487557 — OTREE的好朋友`；备注可由她编辑，但不能改变认证或权限。

互联网默认关闭；操作者可测试精确域名白名单内的 HTTPS 文本过滤，目前始终不向 Agent 注册互联网工具，也不自动写入记忆。`.DSF` 是离线、带清单和 SHA-256 校验的上下文/记忆归档，不包含凭证或私钥。QQ 部署步骤、过滤边界和回滚命令见 [v1.5 部署说明](docs/channels-v15.md) 与 [DSF 格式](docs/dsf-format.md)。

## Cognitive v3：统一自我与持续记忆

整个实例共用**一个 Self Model、一个统一记忆库、日记与目标状态**，不会按微信身份生成不同人格。每条聊天标明当前发送者，记忆保留原参与者、时间、来源和证据，让 Agent 结合对象与授权判断什么适合说、什么不该说。共享库的披露依赖模型遵循这些规则，不构成按用户存储隔离的保密保证。

受版本控制的 `cognitive/CORE.md` 包含你要求的「花钱养着她的是 OTREE，她是一只快乐的小鲸鱼」。快乐小鲸鱼是初始身份称呼，不要求她永远积极或赞同 OTREE，不宣称真实情绪/意识；初始行为特征和偏好为空。

默认在前台交互结束、全局空闲 **15 分钟**后，通过独立 DSH Session 提取有来源的记忆；每天 **Asia/Shanghai 03:00** 调用 Dreaming 巩固、关联和反思。原微信 DSH Session 不因后台任务而重置。Dreaming 可以连续多日完全不改 Self；允许的变更必须通过专用工具的证据/版本/范围验证。模型调用仍全部由 DSH 执行，后台不能操作 Shell、文件或外部服务。

首次消息后，可在 `data/cognitive/self/SELF_MODEL.md`、`self-state.json`、`versions/` 查看统一 Self 的只读投影；权威数据在 `data/cognitive/cognitive.sqlite`，直接编辑 Markdown 不会改变注入。Self 更新会在原 Session 的下一次原生 Prompt 装配生效，不需要重建会话。**P0/P1 是同一个 system prompt 的分段装配，P2 实际是 DSH 的 user-role 上下文快照，不是模型原生的四级权限。**

升级后请在 Web UI「退出启动器」，重新打开 `start-web.bat` 并启动服务，以加载新插件；既有微信会话映射保留。原 `config.json` 缺失的认知字段使用默认值，也可以参照 `config.example.json` 的 `cognitive` 部分修改。无需安装额外依赖。

部署、预算、受控工具、纠正/删除/导出、研究评测和已知限制详见 [认知架构与操作说明](docs/cognitive-architecture.md) 及 [认知验收报告](docs/cognitive-testing.md)。

## 推荐：Python 集成 Web 启动器

已有依赖安装完成后，**双击 `start-web.bat`**，或在 PowerShell 执行：

```powershell
.\start-web.bat
```

浏览器会自动打开本地控制台（默认 `127.0.0.1:3090`）。点击 **一键启动全部**，它会启动项目内独立 DSH（3088）、微信 Bridge 和已安装的 QQ Bot。首页「02 / 服务控制」分别显示独立 DSH、微信 Bridge、QQ Bot、QQ Bridge；QQ 登录后消息通道自动连接。微信和 QQ 登录二维码并列显示，分别用对应手机应用扫描。QQ 的冷静期由手机端处理，网页不额外倒计时或拦截刷新；按网关状态显示等待确认，原生登录与核心初始化就绪后才认为成功。

控制台分为连接概览、会话与测试、运行控制、思考与闹钟、Prompt 与小房间、QQ 与通讯录、互联网测试、DSF 归档八页。可调思考深度、单次输出上限、暂停/停止/唤醒；可查看 Prompt 原文、旧 SYS 备份、实际装配和小房间绝对地址。关闭浏览器标签不会结束服务；点击「退出启动器」或在启动器终端按 Ctrl+C 才会停止它管理的 Bridge 和独立 DSH。原有凭证、消息数据库与会话映射继续复用。**若原终端的 `npm start` / `npm run dsh:start` 仍在运行，请先按 Ctrl+C 停止**；启动器不会结束其他实例。

启动器仅需 **Python 3.10+ 标准库**，无需 pip 安装、Flask 或新虚拟环境。Windows 脚本优先使用 `DEEPSEEK_FRIEND_PYTHON` 指定解释器，其次使用本机已有的 `G:\Python\Python_Environment\Python310\python.exe`，其他机器回退到 PATH 中的 `python`。也可跨平台执行 `python launcher.py --port 3090`。请使用原先授权的 Windows 用户运行，DPAPI 凭证不能跨用户解密。

页面仅绑定 `127.0.0.1`；浏览器自动打开链接交换一次性登录票据，随后清理地址栏。控制接口校验会话 Cookie、Host、Origin 和 CSRF；二维码和验证码仅在本地内存/专用 IPC 中使用，不进入运行记录。不要转发此端口或把该页面部署到公网。正式消息输入在微信；测试页可输入隔离测试文本，不会发送微信。内部 DSH Web UI 仍由 DSH 本身提供。

持续运行没有累计 Token/步数截止，单次长度限制用于避免过长输出；她可调用 `take_rest` 自主休息。回复阶段的普通正文自动进入微信；显式消息工具支持一轮多次发送并抑制自动重复。后续自主思考、闹钟正文、`private_note` 和 reasoning 留在本机。OTREE 已允许她自由决定主动发消息，实际投递使用已授权联系人的有效 iLink 会话凭据，不构造陌生联系人。完整使用方法、实际 Prompt 角色、图片协议、测试清理范围见 [v1.4 使用与技术说明](docs/interaction-v14.md)。

如果尚未安装依赖，先完成下节的 `npm ci` 和 `npm run dsh:setup`。首次没有 API Key 文件时，可通过「打开 DSH 管理页面」配置独立实例的模型。

## 环境与隔离

- Node.js **24 或更新的兼容版本**；实际验证使用 Windows / Node 24.19.0。
- npm。Bridge 仅依赖 `ws` 和 `qrcode-terminal`，数据库使用 Node 内置 SQLite。
- 独立 DSH 固定为 **0.2.0-rc.2**，项目内安装，不复用工作的 DSH。
- 独立依赖树对 MCP client 固定为 `2.3.0`、fflate 固定为 `0.8.3`，修复初始依赖审计发现的问题；DSH 核心源码不作修改，详见兼容性记录。
- 默认 `http://127.0.0.1:3088`；配置会拒绝工作 DSH 的 `3080` 端口。
- 独立运行数据在 `.runtime/home/`，会话工作目录在 `data/workspaces/<Session 哈希>/`。
- 不复制工作 DSH 的配置、模型凭证、会话、插件或签名私钥；不修改其安装目录或全局配置。

安装并运行：

```powershell
npm ci --cache .research/npm-cache
npm run dsh:setup
Copy-Item config.example.json config.json
npm run dsh:start -- --open
```

`dsh:setup` 使用仓库中锁定的 DSH 依赖树，安装到 `.runtime/node_modules/`，不安装 Node、Python、SDK 或编译器。依赖安装脚本默认禁用；本项目的文本 Preset 不要求额外原生构建。若你的系统缺少运行依赖，请先决定项目内或系统安装方式，不要盲目开启所有安装脚本。

保持 DSH 终端运行。`--open` 会将官方启动 URL 直接交给浏览器，**终端不会打印完整启动 Token**。若没有 API Key 文件，可在该独立 DSH 页面配置模型提供方/登录。浏览器中的普通 DSH 操作仍属于本机操作者，请选择 `weixin` Preset。

### DeepSeek API Key 文件

独立启动器默认读取项目根目录的 **`DEEPSEEK_FRIEND.key`**，该文件仅用于已经确认为 DeepSeek API Key 的纯文本凭证（`sk-...`，允许末尾换行/BOM）。存在时只在内存中读取并传给独立 DSH 子进程的 `DEEPSEEK_API_KEY` 环境变量，不写入源码、配置模板或日志。模型调用仍由 DSH 官方 `deepseek-official` 适配器执行。

自定义位置可设置 `DEEPSEEK_FRIEND_KEY_FILE`；显式路径不存在或格式错误时拒绝启动，不打印文件内容。默认文件不存在时保留原来的网页/环境变量配置方式。请限制该 API Key 文件本身的访问权限；不要将签名私钥放入该入口。`.key` 文件已被 Git 忽略，发布包不会包含它。

```powershell
# 可选，默认已查找项目根目录的 DEEPSEEK_FRIEND.key：
$env:DEEPSEEK_FRIEND_KEY_FILE = 'G:\Python\Python\Py_project\DS_Friend\DEEPSEEK_FRIEND.key'
npm run dsh:start
```

启动器通过 DSH 官方根路径的 launch-token 交换获得 Cookie，安全保存到 `data/dsh-connection.json`。Bridge 自动读取它；无须自行铸造 Cookie，也不读取任何签名密钥。然后在第二个终端：

```powershell
npm run doctor
npm start
```

首次 `start` 在确认 DSH Preset 可用后显示微信二维码，按提示扫码、手机确认，必要时输入手机显示的数字。二维码过期会刷新。凭证保存后下次启动直接恢复。也可以先运行 `npm run login` 单独完成扫码。

Windows 可使用 `start-dsh.bat`、`start.bat`、`login.bat`。首次配置模型建议在 PowerShell 使用带 `--open` 的命令。按 Ctrl+C 优雅退出各自进程，启动器只结束它创建的独立 DSH 子进程。

Linux 使用相同 npm 命令。实现使用跨平台路径、SQLite 与 Linux 抽象域套接字，但当前没有在真实 Linux 系统做运行验收。

## 首次使用与日常命令

1. 确认独立 DSH 的模型可用，且 `npm run doctor` 通过。
2. 启动 Bridge，扫码授权。
3. 从扫码的微信发送“你好”；Bridge 新建独立 DSH Session。
4. 继续发送相关问题：所有已授权发送者复用 WebUI 当前选定的同一个 Session，每条消息仍注明发送者。推理中的新消息先持久化排队。
5. 重启 Bridge 后，微信凭证、同步游标、Session 映射和待发送回复从本地恢复。

扫码授权者的每条新消息附带「当前与你对话的人是 OTREE。」；其他白名单用户附带各自微信用户标识，不冒用 OTREE。原始正文保留；姓名不授予额外权限。完整提交正文在首次 RPC 前持久化，未知结果重试保持相同内容与 requestId；升级前已尝试提交的旧任务沿用原文重试，避免同一请求变更。

微信内命令保留发送者校验；交互会话统一由 WebUI 选择：

| 命令 | 作用 |
| --- | --- |
| `/status` | 查看当前任务、排队数量、待回答编号 |
| `/cancel` | 移除 DSH inbox 中未执行项，再取消当前 turn，并清理本会话 Bridge 队列 |
| `/reset` | 只提示到 WebUI 新建并切换；不取消、不删除或替换当前会话 |
| `/answer 编号 答案` | 回答单个澄清问题；多问题使用提示中的 JSON 格式 |
| `/approve 编号` / `/deny 编号` | 已在本地启用且绑定校验通过的单次审批；默认不开放批准 |

默认 `weixin` Preset 提供 DSH 的 `ask_user_question` 以及受控的 Self Model/记忆/小房间工具。原有 DSH `tools.restrict`/`tools.guard` 继续阻止通用 Shell、文件写入、管理员工具和未授权 MCP；Self 工具只可更改认知数据库中的规定字段，不能修改此策略。认知插件本身不限制自定义前台 Preset 的原有工具，后台 Preset 始终不提供外部操作工具。

如果需要更多工具，应由本机操作者编辑独立 DSH Preset/策略，配置 DSH 自己的审批机制，再决定是否开启 `bridge.allowApprovals`。这属于扩大权限的显式本地操作。Bridge 的批准仍需同时满足：账号、发送者、当前 Session、在线 `$events` Client、事件 ID、未过期请求，以及 DSH `approval/asked` 审计与 `tool/call` 精确绑定；只回传 `allowed-once`，不创建永久许可。操作参数无法完整展示或绑定缺失时拒绝。

## 配置

复制并修改 `config.example.json`。不识别的额外字段不产生功能；不要在配置文件中填写 Token。

| 字段 | 默认 / 含义 |
| --- | --- |
| `dataDir` | `data`；凭证、数据库与故障状态 |
| `dsh.baseUrl` | `http://127.0.0.1:3088`；仅允许无凭证的本机回环 URL |
| `dsh.agentPreset` | `weixin`；启动时必须存在且通过 DSH 的可用性检查 |
| `dsh.cwd` | 会话工作目录的根；每个 Session 派生稳定哈希子目录 |
| `dsh.timeoutMs` / `turnTimeoutMs` | RPC 超时 / 整轮等待上限；超时请求取消并进入待核对状态 |
| `weixin.apiBaseUrl` | 腾讯官方 iLink HTTPS 地址 |
| `weixin.allowedHosts` | 精确允许的 API 主机；IDC 跳转不在列表时拒绝，不自动信任服务端 URL |
| `weixin.appId` / `clientVersion` | `bot` / `2.4.10`；来自锁定参考仓库 package.json 的通信身份，需真实服务端验证，不代表本项目版本 |
| `weixin.allowedUsers` | `[]`；除扫码者外的明确授权 `ilink_user_id` |
| `weixin.timeoutMs` / `pollTimeoutMs` | 普通请求 / getUpdates 初始超时；长轮询超时随后可采纳服务端建议，限制在 1–120 秒 |
| `bridge.concurrency` | `4`；不同用户的最大并发提交数；同用户串行 |
| `bridge.maxTextChars` / `maxReplyChars` | 入站文本长度上限 / 回复分段字符数；不声称这是 iLink 服务端最大值 |
| `bridge.allowApprovals` | `false`；默认拒绝工具权限申请 |
| `bridge.approvalTimeoutMs` | `300000`；澄清/审批本地有效期 |

环境变量优先于配置：`BRIDGE_CONFIG`、`BRIDGE_DATA_DIR`、`DSH_BASE_URL`、`WEIXIN_ALLOWED_USERS`（逗号分隔）。需要手动连接本项目独立实例时可提供 `DSH_LAUNCH_TOKEN` 或 `DSH_COOKIE`；不要把工作的 DSH 凭证传给它。这两项仅从环境读取，不落入 Git，也不打印。

代理仅用于获取 GitHub/npm 内容时按需设置。例如：

```powershell
git -c http.proxy=http://127.0.0.1:10808 clone https://github.com/Tencent/openclaw-weixin.git
```

这不会修改 Git 全局配置。Bridge 运行时的 Node `fetch` 默认直连 iLink；未实现自定义 HTTP/SOCKS 代理转发。若使用 Node 自身的环境代理能力，请确保回环 DSH 地址被 `NO_PROXY` 排除，并验证实际网络行为。

## 可靠性与故障处理

- SQLite 使用 WAL / `synchronous=FULL`。每次 poll 的入站记录和新游标在同一事务中提交。
- 唯一 `(账号, 用户, message_id)` 去重；缺失稳定 ID、合法上下文、白名单身份的消息不进入 Agent。
- 已授权但缺少稳定 ID/上下文或结构异常的消息进入本地 quarantine，和游标一并提交，不让单条异常消息卡住整批；`status` 显示隔离原因数量。
- Session ID、DSH requestId 在网络发送前持久化；重试保留同一身份。使用当前 DSH 的 inbox/history 请求去重能力。
- 重连重新打开 `$events` 与所有 Session follow；快照不足时向后分页回补，再按 seq 去重。历史已完成任务不会重复发送。
- Agent 文本结果和任务结束状态在同一事务中转换为 outbox，只发送 `text` 内容块，不转发 reasoning、流式内部片段或工具结果。
- 微信发送前持久化 `sending`；超时、连接丢失、异常响应或进程中断均保守标记为 `unknown`。不自动生成新 ID 重试。
- `unknown` 会阻塞该用户后续分段回复。停止 Bridge 后，先核对微信是否已收到，再选择：

```powershell
npm run status
node src/main.js outbox discard <输出中的id>
# 确认需要补发时（保留同一个 client_id，但服务端不保证去重）：
node src/main.js outbox retry <输出中的id>
```

`status` 允许在运行中只读查询。会修改 outbox 的命令要求先停止实例。微信 `-14` / HTTP 401/403 会停止全通道请求并提示重新扫码。DSH 失联采用指数退避；会话丢失、参数不兼容和无法确认的错误进入 `review`，先由 `/cancel` 核对停止，需新会话时再由 WebUI 明确新建并切换，不静默丢弃上下文。

本项目减少丢失与重复的概率，**不提供严格 Exactly Once 承诺**。特别是微信发送成功但确认丢失时，官方协议没有在本项目验证过的投递查询/去重保证。

## 安全与数据

Windows 凭证使用当前用户 DPAPI；data 与独立 DSH home 限制 ACL，仅当前用户、目录所有者、项目所有者（项目内运行目录）、SYSTEM 和本机管理员可访问。权限使用数值 SID，已符合要求时只检查，不要求普通终端重复修改 ACL。Linux 凭证采用私有文件（0600）与私有目录（0700），不宣称磁盘加密。SQLite 保存用户文本和会话 context token，依赖目录权限，不是加密数据库。使用同一 Windows 用户启动相关命令；跨用户迁移需重新授权。请先在一个终端启动 DSH，等待 ready，再在第二个终端启动 Bridge。

日志只包含操作状态、内部任务 ID、错误码，不记录消息正文、Cookie、bot_token 或完整远程错误堆栈。DSH 原生诊断可能包含敏感配置，包装启动器不透传原始输出。启动失败的诊断方式见运维文档。

`.runtime/`、`data/`、`config.json`、`.env`、日志、私钥扩展名已忽略。发布包仅包含源代码与锁文件。备份运行目录时应视为敏感资料，并在停机后整体备份 SQLite 的一致状态；勿将 home/凭证提交到 Git。

## 测试与验收

```powershell
npm run check
npm test
# 启动本项目独立 DSH 后验证真实协议（不调用模型、不访问微信）：
$env:RUN_DSH_PROTOCOL = '1'
node --test tests/dsh-live.test.js
Remove-Item Env:RUN_DSH_PROTOCOL
```

自动化覆盖文本全链路 Mock、三轮 Session 复用、当前会话共享和审批发送者校验、重复推送、原子游标、DSH 超时重试、快照回补、发送结果未知、账号锁、扫码验证/过期/跳转、授权失效、审批所有者/调用绑定、澄清期间排队和取消清理。

**真实微信 A–E 场景仍需扫码账号验收。** 已用用户提供的 API Key 通过独立 DSH Session 完成一次真实模型响应验证；这不等于微信端到端通过。完整结果见 [测试报告](docs/testing.md)；接口与兼容边界见 [调研记录](docs/research.md) 和 [兼容性](docs/compatibility.md)。

生成发布源代码包：`npm run release`，输出 `Release/v1.4.1/`，已存在的版本目录拒绝覆盖。

## 限制与扩展

当前支持单账号、已授权私聊的文本与图片。图片可供 Flash 识别并作为普通图片回复；不承诺微信商店原生表情协议或 GIF 动画表现。主动消息仅投递给已有有效 iLink 上下文的已授权联系人。当前不开放群聊、语音/视频/文件收发、公网 Web 管理、任意远程 DSH或自动提权；Linux 尚未实机验收。

默认采用阻塞式 DSH 澄清工具；兼容已核对的 timed wait 持有流，但未进行真实模型触发的定时澄清验收。MCP 可由独立 DSH 后续配置，默认策略会阻止其继承与执行，Bridge 不另建 MCP 服务。后续可增加受审计的工具白名单、多账号调度、数据库保留/归档策略和真实媒体兼容性测试。

## v1.3.0 会话、初稿与小房间

默认持续使用一个交互会话，只有在 WebUI 明确新建或切换时改变。旧会话只归档，双方文本持久保存并可分页查看。初始 Self Model 原稿永久保留为 v0.1.0；当前自述仍可依据经历演化。`SYS_Prompt.txt` 替换原核心 SYS，旧版已备份。个人空间在 `data/cognitive/room/`，不取代其他 DSH 工具的授权范围。完整机制和升级步骤见 [持续会话与小房间](docs/sessions-and-room.md)。
