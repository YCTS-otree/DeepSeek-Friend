# DeepSeek:Friend · 微信 ↔ DSH Bridge

版本 **1.0.2**。通过腾讯官方 iLink 长轮询接收个人微信文本，将消息作为真实用户输入提交给 DeepSeek Harness，再将 Agent 的文本结果回复到入站会话。

**DSH 是唯一 Agent Runtime。** Bridge 不调用独立 LLM API，不执行模型工具，不实现 MCP 调度，不依赖 OpenClaw 主程序。默认只接受扫码者；其他用户必须由本地配置明确加入白名单。

## 环境与隔离

- Node.js **24 或更新的兼容版本**；实际验证使用 Windows / Node 24.19.0。
- npm。Bridge 仅依赖 `ws` 和 `qrcode-terminal`，数据库使用 Node 内置 SQLite。
- 独立 DSH 固定为 **0.2.0-rc.2**，项目内安装，不复用工作的 DSH。
- 独立依赖树对 MCP client 固定为 `2.3.0`、fflate 固定为 `0.8.3`，修复初始依赖审计发现的问题；DSH 核心源码不作修改，详见兼容性记录。
- 默认 `http://127.0.0.1:3088`；配置会拒绝工作 DSH 的 `3080` 端口。
- 独立运行数据在 `.runtime/home/`，会话工作目录在 `data/workspaces/<账号与用户哈希>/`。
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
4. 继续发送相关问题：同一账号和用户复用该 Session。推理中的新消息先持久化排队。
5. 重启 Bridge 后，微信凭证、同步游标、Session 映射和待发送回复从本地恢复。

微信内命令均只作用于发送者自己的会话：

| 命令 | 作用 |
| --- | --- |
| `/status` | 查看当前任务、排队数量、待回答编号 |
| `/cancel` | 移除 DSH inbox 中未执行项，再取消当前 turn，并清理本会话 Bridge 队列 |
| `/reset` | 完成上述取消后移除映射；下条消息建立新 Session，旧历史/工作文件保留 |
| `/answer 编号 答案` | 回答单个澄清问题；多问题使用提示中的 JSON 格式 |
| `/approve 编号` / `/deny 编号` | 已在本地启用且绑定校验通过的单次审批；默认不开放批准 |

默认 `weixin` Preset 仅挂载 DSH 的 `ask_user_question`。通过 DSH 原生 `tools.restrict` 隐藏所有继承工具，并通过 `tools.guard` 拒绝其他执行，包含 Shell、文件写入、管理员工具和任意 MCP。微信文本不能修改此策略。

如果需要更多工具，应由本机操作者编辑独立 DSH Preset/策略，配置 DSH 自己的审批机制，再决定是否开启 `bridge.allowApprovals`。这属于扩大权限的显式本地操作。Bridge 的批准仍需同时满足：账号、发送者、当前 Session、在线 `$events` Client、事件 ID、未过期请求，以及 DSH `approval/asked` 审计与 `tool/call` 精确绑定；只回传 `allowed-once`，不创建永久许可。操作参数无法完整展示或绑定缺失时拒绝。

## 配置

复制并修改 `config.example.json`。不识别的额外字段不产生功能；不要在配置文件中填写 Token。

| 字段 | 默认 / 含义 |
| --- | --- |
| `dataDir` | `data`；凭证、数据库与故障状态 |
| `dsh.baseUrl` | `http://127.0.0.1:3088`；仅允许无凭证的本机回环 URL |
| `dsh.agentPreset` | `weixin`；启动时必须存在且通过 DSH 的可用性检查 |
| `dsh.cwd` | 会话工作目录的根；每个账号/用户派生独立哈希子目录 |
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

`status` 允许在运行中只读查询。会修改 outbox 的命令要求先停止实例。微信 `-14` / HTTP 401/403 会停止全通道请求并提示重新扫码。DSH 失联采用指数退避；会话丢失、参数不兼容和无法确认的错误进入 `review`，由 `/cancel` 或 `/reset` 可控处理，不静默丢弃上下文。

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

自动化覆盖文本全链路 Mock、三轮 Session 复用、用户隔离、重复推送、原子游标、DSH 超时重试、快照回补、发送结果未知、账号锁、扫码验证/过期/跳转、授权失效、审批所有者/调用绑定、澄清期间排队和取消清理。

**真实微信 A–E 场景仍需扫码账号验收。** 已用用户提供的 API Key 通过独立 DSH Session 完成一次真实模型响应验证；这不等于微信端到端通过。完整结果见 [测试报告](docs/testing.md)；接口与兼容边界见 [调研记录](docs/research.md) 和 [兼容性](docs/compatibility.md)。

生成发布源代码包：`npm run release`，输出 `Release/v1.0.2/`，已存在的版本目录拒绝覆盖。

## 限制与扩展

首版为单账号、已授权私聊的文本 MVP。媒体消息会明确提示不支持，不下载附件；已保留消息类型与 API 分层，未来媒体实现需要域名、大小、超时及解密校验。当前不开放群聊、主动联系人发送、Web 管理界面、任意远程 DSH、Linux 实机支持承诺或自动提权。

默认采用阻塞式 DSH 澄清工具；兼容已核对的 timed wait 持有流，但未进行真实模型触发的定时澄清验收。MCP 可由独立 DSH 后续配置，默认策略会阻止其继承与执行，Bridge 不另建 MCP 服务。后续可增加受审计的工具白名单、多账号调度、数据库保留/归档策略和真实媒体兼容性测试。
