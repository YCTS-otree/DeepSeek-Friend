# 运维与恢复

v1.2.0 增加全实例统一 Self/记忆库，默认空闲 15 分钟提取、Asia/Shanghai 03:00 反思。升级时在 Web UI 退出启动器后重新运行，以装入新插件；不要清空微信映射。认知状态、预算、纠正/回滚、原始日志删除边界见 [cognitive-architecture.md](cognitive-architecture.md)。Self 的描述性变化不修改原工具权限。

## 进程与运行目录

推荐双击 `start-web.bat`，在自动打开的本地 Web UI 点击「启动服务」。Python 统一管理本项目独立 DSH 与 Bridge，网页显示可扫描的 SVG 二维码和验证码交互；详细控制、安全与恢复规则见 [web-launcher.md](web-launcher.md)。切换前先停止旧终端实例。关闭标签页继续运行，「退出启动器」或终端 Ctrl+C 才停止服务。

两个终端分别运行 `npm run dsh:start -- --open` 与 `npm start`。所有 DSH 状态均在项目 `.runtime/home`；不使用系统默认 `~/.dsh`。只有首次创建 profile 时使用 `--from-default-profile web`，随后复用；重启不得覆盖模型配置。包装器捕获自己的子进程启动凭证并做官方交换，不输出完整 Token，也不扫描历史日志。

账号锁使用 Windows 命名管道 / Linux 抽象域套接字：同一账号即使使用不同 data 目录也不能同时轮询。data 目录还有独立 SQLite 排他锁；进程退出后由操作系统释放，不依赖删除陈旧 PID 文件。该账号锁防止本机本项目实例竞争，不能阻止另一台电脑或不遵守同一锁协议的程序接入。

Windows DPAPI 与当前 Windows 用户绑定。请使用同一用户运行 DSH、Bridge 和登录命令；不同用户不能解密彼此凭证。重新启动项目 DSH 会重新保存该用户可用的 DSH Cookie。微信凭证跨用户迁移时需要重新扫码，不要复制工作 DSH 的密钥。

Windows 运行目录 ACL 使用当前用户及所有者的数值 SID。对项目内目录显式保留项目所有者权限，避免开发/测试账号创建目录后，项目所有者在普通 PowerShell 中因管理员组被 UAC 过滤而失去访问权。已符合私有 ACL 要求时直接通过，不在每次启动强制修改 DACL；仍拒绝 Everyone、Users、Authenticated Users 的宽泛授权。v1.0.2 已修复本项目既有 data 与独立 home 的此类问题，并在实际 Administrator 账号下验证。

独立启动器从项目根目录 `DEEPSEEK_FRIEND.key` 或显式 `DEEPSEEK_FRIEND_KEY_FILE` 读取已确认的 DeepSeek API Key，只传入 DSH 子进程环境。替换 API Key 文件后需重启独立 DSH。不会扫描其他凭证文件或打印 Key；签名私钥禁止用于此入口。默认文件不存在时仍可在独立 DSH 页面配置模型。该 API Key 文件本身应由操作者限制权限。

## 常见错误

| 错误码 | 处理 |
| --- | --- |
| `dsh-auth-required` | 先运行独立 DSH 启动器；自动保存 connection 后重启 Bridge |
| `dsh-auth-rejected` | Cookie 过期或错误实例；重启独立启动器/Bridge，或更换显式环境凭证 |
| `deepseek-key-file-missing` / `deepseek-key-file-invalid` | 检查显式 API Key 路径与纯文本 sk- 格式；勿在终端打印凭证 |
| `dsh-preset-missing` | 确认项目 patch 已应用；用独立 DSH 页面查看 weixin Preset 诊断，不要改工作实例 |
| `dsh-network` / `dsh-stream-network` | 检查 3088 实例与网络；重试保持 requestId，勿手动重复发送原消息 |
| `session/not-found` / `dsh-event-gap` | 任务保留 review；核对 DSH 状态后从微信 `/reset`；不会自动改为另一用户 Session |
| `dsh-inbox-invalid` | DSH 数据结构变化，取消操作拒绝继续；先做版本适配，避免遗留队列继续执行 |
| `turn-timeout` | Bridge 已请求取消；用 `/status` 核对，必要时 `/cancel` 或 `/reset` |
| `ilink-auth-expired` | 通道请求已停止；执行 `npm run login` 重新授权 |
| `ilink-host-rejected` | 查看腾讯返回的实际 IDC 主机；由操作者核验后加入 `weixin.allowedHosts`；不要开放任意域名 |
| `pending-stale-or-foreign` | 编号已过期、其他用户、会话重置或连接变化；使用当前仍有效的新提示 |
| `data-directory-access` / `data-acl-access-denied` | 目录访问或 ACL 权限不足，应由原目录所有者修复当前用户权限；不要开放 Everyone |
| `data-acl-tool-failed` / `data-acl-verify` | Windows PowerShell/ACL 检查失败；程序拒绝退回不受保护目录 |
| `credential-protection` | 检查 Windows 用户/DPAPI；先以同一用户启动 DSH 刷新连接 Cookie，微信授权仍需原用户或重新扫码 |
| `instance-running` / `account-running` | 停止已有实例；不要通过复制凭证绕过锁 |

DSH 包装启动器对未经脱敏的原始日志采用不透传策略，避免上游诊断意外泄密。如果 `dsh.exited` 无法定位，应由本机操作者在自己的交互终端以同一 `.runtime/home`、profile 和 `.runtime/weixin-resolved.patch.yml` 运行 DSH 官方 CLI 查看诊断；不要把原始诊断或启动 URL 贴到公共日志。先确认端口空闲、profile 已创建、包版本正确。**Bridge 的 doctor 只能验证鉴权/Preset，不能证明模型已登录。**

## 发送结果未知

`npm run status` 显示 jobs/outbox 的状态统计和本地故障 ID，不展示正文或凭证。`unknown` 表示发送可能已经生效；先看手机聊天记录，停止 Bridge，然后 `outbox discard <id>` 或 `outbox retry <id>`。retry 保留原请求体和 client_id；协议没有经验证的投递查询，仍可能重复，勿盲目批量补发。

明确 iLink 业务拒绝进入 failed；429 可自动退避；认证失效停止请求。Bridge 进程异常时 `sending` 在下次启动变为 unknown。后续分段不会越过同一用户前面的 unknown/pending 消息，以避免乱序。

DSH 的 submitting 状态可用同一 Session/requestId 重试；waiting 在事件流恢复后回补。review 保持阻塞该用户的新 Agent 提交，控制命令仍能处理。不要手工删除数据库行来假装任务成功。

## 备份与数据保留

停掉两个进程后备份 `data/` 与 `.runtime/home/`，它们包含敏感文本、上下文令牌和 DSH 自己的凭证。SQLite 如有 WAL/SHM 应保持一致；不要在线只复制主数据库。Windows DPAPI 数据不能简单搬到另一用户/机器。不要打开或检查 DSH 的签名密钥文件。

当前不自动删除正式聊天或 vacuum；部署者应监控磁盘占用。`/reset` 只提示在 WebUI 新建/切换，不更改会话。正式会话仅归档；测试清理的范围与保留项见下节。

已授权但缺失合法消息标识、上下文或结构异常的入站包会进入 quarantine，与游标在同一事务内保存，避免单个坏包使整批无限重试。status 仅展示数量与原因，不展示敏感原文；当前不自动重放隔离包，须先完成协议适配后由本机操作者审慎恢复。

## 测试命令

常规：`npm test`、`npm run check`。真实独立 DSH：设置 `RUN_DSH_PROTOCOL=1` 后执行 `node --test tests/dsh-live.test.js`；该测试只创建带 protocol-test 前缀的空 Session 并检查控制协议，不调用模型和微信。

真实微信验收按 docs/testing.md 执行。遇到网络故障先用单个测试账号验证；不要把自动化成功当作真实投递证明。

## v1.3.0 升级与会话维护

先在 WebUI 退出启动器，再重新运行 start-web.bat。当前 Session 不自动重置。`/reset` 仅提示使用 WebUI；新建并切换会归档旧会话。SYS 原文已替换并备份；初始 Self v0.1.0 独立保留。旧配置若显式使用 2400/8000 的 self/input 预算，请按 config.example.json 调为 12000/24000，以容纳完整初稿。

- `session-busy`：等待当前任务/审批/出站消息完成；review 用 /status 核对，必要时 /cancel。未知 outbox 按原维护流程人工核对。
- `session-result-unknown`：刷新列表确认结果，避免重复新建。
- `historical-self-integrity`：历史原稿或清单不一致，拒绝覆盖；从自己保留的原稿/版本库恢复，不要随意重算哈希掩盖差异。
- `room-version-conflict`：先读最新文件，再以其 sha256 保存。
- `cognitive-chat-retention-archive-only`：当前保留策略禁止会话历史破坏性清理，使用归档/纠正。

完整规则见 [sessions-and-room.md](sessions-and-room.md)。

## v1.4 运行控制与图片

退出旧启动器后重新打开 start-web.bat 加载新插件。模型固定为 DeepSeek-V41-Flash，思考深度在「运行控制」设置；单次输出上限不构成累计预算。停止/暂停不会清空上下文。持续运行期间费用与磁盘记录持续累积。

- `test-clear-dsh-running`：Bridge 停止但独立 DSH 仍在运行，无法确认测试 Agent 已停。由启动器连接 Bridge 后清空，或先停止独立 DSH。
- `test-worker-busy`：等待隔离测试的记忆整理完成。
- `known-contact-required`：尚无真实合法入站凭据，或指定 recipient 不在已知联系人中；需要联系人先发来消息。
- `image-too-large` / `image-format` / `image-decrypt`：检查图片大小、格式及官方密钥字段；不会把损坏图片当作已识别内容。
- `cdn-host-rejected`：官方返回了白名单外目标或异常 URL；先核对官方源码再调整本机配置，不信任聊天提供的下载域名。

主动联系已获得用户授权，但有效 context_token 仍由腾讯决定。服务端明确拒绝进入 failed；结果不明进入 unknown，按原流程核对，不换消息 ID 自动重发。图片上传回执与最终消息分开持久化。

正式思考记录在 data/interaction.sqlite，只从认证控制台读取；不要将数据库或包含私有思考的截图公开。测试清理停止测试 Agent 并清空应用测试记录/记忆，保留历史 Self 原稿、测试房间文件与上游 DSH 原始运行日志，不声称物理擦除。完整说明见 [interaction-v14.md](interaction-v14.md)。

## v1.4.1 旧会话工具加载

若出现 DSH Agent 异常且模型返回 INVALID_REQUEST、at least one tool must have defer_loading=false，升级至 v1.4.1 并重启项目实例。补丁通过原生 request series 兼容旧空工具基线，原 Session 和消息保持保留。当前实例已应用，不必新建会话。完整复现与验证见 [incident-tool-loading.md](incident-tool-loading.md)。
