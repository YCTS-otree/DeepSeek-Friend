# 运维与恢复

## 进程与运行目录

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

当前不自动删除历史记录或 vacuum；部署者应监控磁盘占用。需要永久清理时先确定保留与隐私要求，再设计数据库归档。`/reset` 只改变会话映射并停止任务，不删除历史聊天、旧 Session 或用户工作文件。

已授权但缺失合法消息标识、上下文或结构异常的入站包会进入 quarantine，与游标在同一事务内保存，避免单个坏包使整批无限重试。status 仅展示数量与原因，不展示敏感原文；当前不自动重放隔离包，须先完成协议适配后由本机操作者审慎恢复。

## 测试命令

常规：`npm test`、`npm run check`。真实独立 DSH：设置 `RUN_DSH_PROTOCOL=1` 后执行 `node --test tests/dsh-live.test.js`；该测试只创建带 protocol-test 前缀的空 Session 并检查控制协议，不调用模型和微信。

真实微信验收按 docs/testing.md 执行。遇到网络故障先用单个测试账号验证；不要把自动化成功当作真实投递证明。
