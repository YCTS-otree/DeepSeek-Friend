# v1.4：交流、视觉、持续运行与本地控制台

记录日期：2026-10-22。DSH 固定 0.2.0-rc.2，不修改 DSH 核心；工作 DSH 的目录与 3080 端口不参与此功能。

## 升级与使用

先在旧控制台点击「退出启动器」，再双击 `start-web.bat`、点击「启动服务」。新版本复用已有授权、正式会话与认知数据，不自动新建正式会话。缺失的新配置使用默认值，无需安装新依赖。默认仅在本机 3090 打开控制台。

命令行可使用 `python launcher.py --start` 自动启服，仍只管理本启动器创建的进程。当前用户实例已按授权完成重启部署，无需再次执行升级步骤。

页面分为五个入口：

| 页面 | 可用操作 |
| --- | --- |
| 连接概览 | 启停独立 DSH/Bridge、扫码、验证码、授权状态、脱敏日志 |
| 会话与测试 | 查看双方聊天记录、新建/切换正式或测试会话、发送测试文本、清空测试空间 |
| 运行控制 | 思考 off/low/high/max、单次输出上限、续行间隔、允许持续思考、暂停新请求、停止/唤醒所选会话 |
| 思考与闹钟 | 查看并分页读取本机 reasoning、私有笔记与用量；设定/取消闹钟 |
| Prompt 与小房间 | 查看核心 SYS、当前 Self、所选会话最近实际装配的 SYS、旧 SYS 备份；显示并复制小房间地址 |

顶部「当前查看」只改变查看对象。正式交互仍只有一个当前会话；必须在会话页显式新建或切换才改变微信去向。测试有独立的当前会话，不改变正式当前会话。忙碌或存在未知投递结果时不允许切换正式会话。

核心 SYS 继续使用用户提供的替换原文，旧 SYS 与 Self v0.1.0 历史原稿不变。Prompt 页面只读，不直接改数据库或权限。最近实际 SYS 尚无记录时会明确显示未装配，不拿模板冒充实际请求。

默认正式小房间绝对路径为 `G:\Python\Python\Py_project\DS_Friend\data\cognitive\room`；自定义 dataDir 时以页面读取结果为准。测试会话显示自己的 `data/testing/cognitive/room`。小房间不构成全局文件访问边界；其他工具仍受 DSH 实际授权约束。

## 模型与继续运行

实际 DSH 模型目录已确认：provider `deepseek-official`、model `deepseek-flash`、显示名 **DeepSeek-V41-Flash**。前台请求通过原生 `agent/request` 钩子固定到这一模型；没有切换到 Pro、另建模型调用后端或用识别失败降级代替视觉。

运行设置保存在 `data/interaction.sqlite`，下一次模型请求读取最新值。默认 high、单次最多 8192 Token、允许继续、续行间隔 1000ms。单次可设 256–65536 Token，间隔 0–60000ms。这个限制用于每次请求的输出长度，不是累计运行预算，也不是生命周期上限。没有累计 Token、步数或整轮推理时长截止；原 `dsh.turnTimeoutMs` 只用于关闭 interaction 的旧聚合模式。

当前 DSH 原生自动压缩来自 `@deepseek-ai/dsh-compaction-basic`，在 `agent/pre-step` 检测上下文压力并处理 context-window 错误。Bridge 复用它，不自行维护另一套模型上下文。单次输出截断后允许继续下一步。不能保证所有上游网络、服务端错误或无限长上下文都不会失败；错误进入原有 review/恢复流程。

模型准备结束时，`agent/turn-stopping` 在策略允许、没有新用户输入、未暂停且未主动休息时，通过 `agent.inject()` 将固定内部续行信号放入 **next-step**，继续同一轮。DSH 的这个接口只接受 **user-role UserMessage**：信号标有 `source.kind=friend-continuation`，不冒充用户本人或 developer 权限。续行的行为规则由可信 system section 提供；Self 仍经独立 system section 装配，不作为续行消息重复塞入。

新消息使续行在当前模型步骤完成后让出边界，再按队列提交；不会中途丢弃当前模型输出。她也可以调用 `take_rest`，使用 DSH 原生 `concludeTurn()` 结束当前轮并等待下次唤醒。「暂停」阻止新推理与闹钟，进行中的网络请求使用「立即停止」取消。取消后保留原上下文和记录。

持续运行会持续调用已配置模型并累积费用；这是允许持续运行的实际行为。需要停下时可暂停、停止、允许她主动休息或关闭服务。调试异常任务时先停止所选会话，再唤醒，避免 review 任务阻塞新队列。

## 一轮多次消息与主动联系

原生工具 `weixin_send_message({text,recipient?})` 每次生成一条独立持久发送意图，允许同一轮多次调用。从 v1.4.2 起，联系人发来的消息在首次回复阶段产生的普通 assistant 正文，会在原生停止边界自动排队，再进入同轮自主继续阶段。已使用发送工具时抑制自动转发，避免重复；`private_note({text})` 明确选择私有阶段，后续需要对外发言时使用发送工具。自主继续阶段、内部闹钟的普通正文及 reasoning 都只保存在本机。历史私有笔记不会自动补发。聊天页记录明确对外的发送意图，不等同于手机已收到。

OTREE 已明确授权她自主决定何时主动发消息。`weixin_contacts` 列出已授权且保有合法 iLink 入站凭据的联系人；`recipient` 使用这里的 ID。省略时优先当前交互对象；内部闹钟使用原会话最近对象，没有历史绑定时选择最近联系人。不会构造陌生联系人或绕过腾讯接口限制。白名单撤销后不能继续投递。

账号、联系人、context_token 和适用的 run_id 均取自已保存的真实入站消息；不会把 token 暴露给模型。正式归档会话的历史仍保留，发送记录保存在实际产生它的会话中。服务端可能拒绝过期 context_token，届时明确失败，需要联系人重新入站刷新上下文；不存在已验证的任意联系人无限期主动发送契约。

发送工具返回 queued，不能声称已送达。工具 call ID、所属任务和 Session 形成稳定意图 ID；Bridge 幂等写入聊天和 outbox，固定 client_id 和请求体。发送超时/未知结果进入 unknown，后续同联系人的消息不越过它；不盲目换 ID 重发。仍不宣称 Exactly Once。

## 图片与表情

微信入站的 `image_item` 通过官方 CDN 下载、AES-128-ECB/PKCS7 解密，按字节识别 PNG/JPEG/WebP/GIF，并保存内容哈希。原图片作为 DSH 原生 `{type:'image',mediaType,data,name}` 输入交给 Flash；模型获得图片库 ID，可用 `sticker_note` 保存含义和用法的解释。解释属于推断，不自动升级为事实或 Self 证据。

`sticker_list` 查看图片库；`weixin_send_sticker({id,recipient?})` 将已有图片以普通图片消息发送，使用官方 getuploadurl、加密 CDN 上传和 image_item。上传 filekey/AES 与回执持久化，最终发送沿用稳定 client_id。这不是微信商店原生表情协议，不承诺 GIF 动画呈现或复用 QQ/NapCat 收藏接口。

默认每条入站最多 4 张、每张最多 8MiB、下载上传超时 20 秒；HTTPS 域名白名单默认只有 `novac2c.cdn.weixin.qq.com`，拒绝跳转和任意目标 URL。未实现语音/文件/视频收发。媒体原文及含 base64 的已提交请求保存在私有 dataDir，不进 Git。

## 小闹钟

`alarm_set({at,note?})` 接受带时区的未来 ISO 时间，不要求原因；`alarm_list`、`alarm_cancel` 管理它。她醒来可以思考、读写已授权空间、主动联系已有联系人或休息，不强制输出。

闹钟持久化，重启后补执行；同一闹钟使用稳定任务身份防止重复唤醒。正式对话优先，当前有任务或排队输入时等待；归档会话保持待执行，切回该会话后再补执行。唤醒以「内部小闹钟」明确标识，记忆来源为 runtime，不伪记成 OTREE 说的话。Dreaming 继续使用无外部操作权限的独立后台 Session，与闹钟交互轮不同。

## 测试隔离与数据

测试使用 `weixin-test` Preset、独立聊天目录及 `data/testing/cognitive` 下的 Self/记忆/日记/目标/房间；正式仍是统一 Self 和统一记忆库。测试消息工具仅写本机测试聊天，不发微信；不列出真实联系人和正式图片库。当前测试输入框仅支持文本，真实视觉测试使用独立脚本附带合成图片。

清空测试先阻止新测试提交、取消测试 Agent、等待处理链，再清空应用测试聊天/任务/思考/闹钟/测试记忆及索引。正式会话不能删除，只能归档。清空保留原始 Self 历史版本和房间文件；上游 DSH 的原始 Session 日志仍在其私有 home 中，界面不会冒称完成物理擦除。Bridge 停止但 DSH 仍运行时拒绝离线清空，避免未停 Agent 在清空后重新写入。

私有 reasoning、普通笔记、用量、最近 SYS 位于 `data/interaction.sqlite`；完整 DSH 事件另由 DSH 原生存储。内容经本机控制台的 Cookie/Host/Origin/CSRF 检查与专用 IPC 返回，不进入状态日志。保存的是 DSH 实际返回内容；off 档或模型未返回 reasoning 时不会伪造思考。

## 源码依据与许可证

通过用户要求的 GitHub 代理获取并阅读：

- qq-bridge `a49877f4e58d04e47532d44b803360d0f001160d`，重点为 `src/bridge.js` 的显式消息工具、多条投递、表情集合和备注。QQ/NapCat/SnowLuma 表情接口不具备微信兼容性；本项目移植交互方式，以 iLink 图片传输替代这些接口。
- Tencent/openclaw-weixin `874637a0dbc24050f72d1385add4fc6170a2d726`：`src/api/types.ts`、`src/api/api.ts`、`src/cdn/cdn-upload.ts`、`src/cdn/pic-decrypt.ts`、`src/cdn/upload.ts`、`src/messaging/send.ts` 等的真实字段和 AES 约定。协议文档不作为完整服务端契约。
- 本机发布包 `dsh-tools` 的作用域继承/执行 guard，`dsh-agent-loop` 的 stopping/inject/concludeTurn，`dsh-llm-deepseek` 的 Flash 视觉与思考档位，`dsh-system-prompt` 的实际角色装配。

参考项目为 MIT；保留 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 的许可证和署名。不修改上游仓库，不依赖 OpenClaw 主程序。

## 验证边界

自动化覆盖持久意图与多次消息、私有思考分离、无累计截止的续行、闹钟补执行/幂等、已知联系人主动发送、未知投递隔离、原生图片请求固定重试、图片解密/域名/大小/上传缓存、测试清理及 Web 页面状态隔离。实际结果见 [interaction-testing.md](interaction-testing.md)。

真实 Flash/隔离 DSH 已测试原生图片识别、一轮两次消息工具、同轮继续思考和 reasoning 持久化。没有将这些测试视为真实微信投递验收；微信图片往返、原生微信表情表现、长时间运行至真实上下文压力、闹钟后实际主动投递仍待账号环境检验。
