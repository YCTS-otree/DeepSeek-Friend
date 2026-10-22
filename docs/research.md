# WP01 源码调研与技术决策

日期：2026-10-22。所有参考均读取实际源代码，未执行上游的自动发现、密钥读取或安装脚本。

## 环境调查

工作区初始仅有空 Git 仓库，没有提交、远程或用户源码。Node 24.19.0、npm 11.17.0、Python 3.10.11、Git、ripgrep 已安装；Node 内置 SQLite 可用，无需安装工具链。Git 因运行身份不同报告 safe.directory，调查和提交使用命令级 `-c safe.directory=...`，不修改全局配置。

按任务许可只读查看了 `G:\DeepSeek_Harness` 的包清单及 `node_modules/@deepseek-ai` 中相关实现，版本为 `0.2.0-rc.2`，初始 `3080` 探测拒绝连接。没有打开凭证/密钥文件，没有启动、修改或复用工作的 DSH。用户随后明确要求额外集成独立实例：所有后续运行测试均针对本项目 `.runtime/` 的 DSH，端口 3088。

初次直连 GitHub 失败，临时通过 GitHub 连接器保存了源码快照供调查。按用户“GitHub 走代理”要求，定位到本机 Xray 的 10808 端口，随后使用命令级 `http.proxy=http://127.0.0.1:10808` 成功完成两个真实 Git clone。上游仓库工作区保持干净。提交及 blob 记录见 reference-sources.json。

## qq-bridge

仓库：<https://github.com/Derpyu520/qq-bridge>；本次 clone 的 HEAD：`a56164e70a0521a7829138a42eee76066fde2b8b`。

| 调查点 | 实际实现与本项目决定 |
| --- | --- |
| `src/dsh-client.js` | slash RPC + request 包装、requestId、Cookie、remote.mux、follow 集合跨重连保留。兼容逻辑有用；不直接引入继承自旧 apiproxy 的客户端，避免携带旧版本依赖和自动读密钥路径 |
| `src/bridge.js` | 真实 Agent 提交、按 turn 收集、Session key 路由、请求等待、快照与 live 事件分开。借鉴持久映射和不重播历史回复，未复制 QQ 社交模拟/控制台/调度体系 |
| 鉴权 | 当前参考实现优先用本地持久化签名密钥铸造 Cookie，并有 launch-token 回退。本项目明确不采用该路径，使用独立 DSH 公开的 launch-token 交换；无签名私钥扫描或日志 Token 发现 |
| Session 控制 | 0.2.0 的 `session/projections.values.inbox` 替代旧控制数据。cancel 保留 inbox，archive 仅隐藏。取消必须先移除 queue item 的真实 MessageId，再 cancel |
| 结果 | `assistant/message` 的 message/content；turn/start/end。只选择 text，忽略 reasoning、assistant-stream 和工具结果 |
| 提问/审批 | `$events` 的 ready/clientId、waterfall/eventId/agentId/request，经 `$events/result` 回传。必须绑定账号、用户、Session、当前 clientId 与审计/调用；不做“同意即任意授权” |
| Preset | 检查了 `plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml`、`dsh/agent-presets/qq-chat/agent.cordis.yml`。通过 Cordis preset 声明挂载 scoped 插件，而非旧目录扫描。Persona 使用 prefix/suffix 而非旧 text 字段 |
| 工具隔离 | 检查了 `plugins/qq-agent-presets/qq-tool-restrict.mjs`。注册期 restrict 与执行期单调 guard 各有作用。针对本项目的无主机工具默认值，直接 restrict allow 空集、执行期仅放行澄清工具；没有照抄易漂移的危险工具黑名单 |
| MCP | 阅读 `src/mcp-snowluma-safe.js` 和 Preset 的 host MCP 说明，确认 MCP 由 DSH 提供给 Agent，桥接不应另建模型/工具运行时。本项目不引入 SnowLuma、不挂载 QQ MCP、不复制其依赖；后续安全 MCP 由独立 DSH 配置 |
| 兼容性测试 | 检查 `scripts/verify-dsh-020-adaptation.mjs`、`scripts/test-dsh-auth.mjs` 等源码。没有运行会读签名密钥的上游测试，自己实现网络与状态测试，并真实核验项目独立 DSH |

复用结论：复用协议知识和经源码确认的行为，**未整体复制 qq-bridge 的客户端、业务 Bridge 或 MCP**。独立实现约束更小的适配层，避免引入旧 apiproxy、QQ 特性、密钥访问和全局 DSH 配置写入。保留 MIT 署名通知，源码快照仅作为被 Git 忽略的调研资料。

## 腾讯 iLink

仓库：<https://github.com/Tencent/openclaw-weixin>；本次 clone 的 HEAD：`874637a0dbc24050f72d1385add4fc6170a2d726`。

- `src/api/api.ts`：认证头、App-ID/编码版本、base_info、长轮询时限、JSON uint64 标识保留、getConfig/typing、sendMessage 错误处理。另读取实际 package.json 得到客户端版本 2.4.10 和 appId=bot，没有沿用协议文档的 2.4.8 示例。QR POST 不额外附加 base_info，QR GET 仅携带官方 common headers。
- `src/api/types.ts`：BOT/USER、TEXT/IMAGE/VOICE/FILE/VIDEO、状态枚举、context_token、run_id、游标与错误字段；媒体类型保留为后续扩展边界。
- `src/auth/login-qr.ts`：POST get_bot_qrcode/local_token_list、GET 状态轮询、验证码、过期刷新、IDC 跳转、already-bound 行为；支持源代码中的全部状态。
- `src/monitor/monitor.ts`：长轮询、服务端建议 timeout、-14 会话超时与退避。上游游标先落文件后处理；本项目改为 inbox+cursor 单个事务，降低崩溃丢失风险。
- `src/messaging/send.ts`：完整文本消息构造，包括空 from_user_id、client_id、context_token、BOT、FINISH 和 run_id；不将类型可选字段当成服务端可省略证明。
- `src/channel.ts`：渠道在 OpenClaw SDK 上的装配、账号恢复、登录和出站入口；本项目只实现独立 iLink 客户端，不导入 OpenClaw SDK。
- 补充检查 `src/messaging/process-message.ts` 的入站处理，避免只凭文档假设入站必须带 FINISH。接收 NEW/FINISH 或缺省状态，忽略生成中的片段。
- `docs/protocol_zh_CN.md`：明确区分客户端行为与服务端契约，文档示例不构成最小合法请求。本项目使用实际构造字段做 Mock 契约断言，仍将真实扫码/投递列为待验收。

未沿用上游“发送异常后上层重新生成 ID”的调用模式；outbox 在发送前固定 ID，对未知结果暂停自动重发。也没有把上游的多次失败固定退避当作唯一服务端限流契约，采用指数退避并对明确 429 保留同一请求身份。

## 本地 DSH 源码核对

核对包：`dsh-client-connection`、`dsh-api-gateway`、`dsh-api-remotes`、`dsh-api-session-controller` 及生成的 `typert.host.js`/类型，`dsh-session`、`dsh-user-approval`、`dsh-user-questions`、`dsh-agent-preset-registry`、`dsh-tools`、`dsh-web-app` 与 `dsh-home-paths`。

确认：Web Cookie 代表 operator；requestId 的 inbox/history 去重；follow 的 SessionAddress/事件封装及分页；0.2.0 projection 形状；approval asked/decided 审计；waterfall 请求的 agentId；timed question 的 attachWait 生命周期；Preset 子插件作用域与 ESM URL；独立 DSH_HOME 和 Web host/port flags。

没有依赖在磁盘上推导 launch token。启动器只接收自己创建的独立 DSH 子进程输出中的官方启动 URL，在内存中交换 Cookie；原始 URL和诊断不进入持久日志或响应。

## 可靠性选择

采用 JavaScript ESM：与参考桥接一致，Node 24 自带 fetch、AbortSignal、SQLite 和 JSON reviver source，不需要构建器或新增 Python 环境。小模块覆盖协议、认证、安全、SQLite、DSH、收发状态机和 CLI，没有新 Agent 框架。

入站与游标一事务；Session/requestId 在调用前持久化；文本结果与 outbox 一事务；每个会话串行、不同用户有限并发；账号锁由 OS 生命周期释放；重连进行 follow 快照回补；不可确认的微信投递进入 unknown，人工核对后保留原 ID 补发。SQLite 保留恢复事实，但不把无法观察的远端状态包装成 Exactly Once。

默认数据目录权限限制 + Windows DPAPI；Linux 使用私有文件；不会声称数据库加密。会话上下文隔离还包括工作目录按账号/用户哈希划分。扩大工具/MCP 范围只允许本地操作者修改独立 Preset 与 DSH 策略。

## 验证中发现并修复的问题

1. Windows 下绝对盘符字符串不能直接作为 ESM import specifier：策略模块和浏览器 opener 使用 file URL。
2. `--from-default-profile` 只允许初始化，不可在每次启动重复指定；启动器检查独立 profile 是否已存在。
3. iLink 返回的 baseurl 可带末尾斜杠；请求 URL 从已验证 origin 重新构造，避免双斜杠端点。
4. 审批不能在用户答复时选择“最新”的 audit ID，必须在展示时绑定唯一未决审计，再核验完整投递、当前连接和原始操作。

## 尚待真实验证

微信扫码、验证码/IDC 实际行为、bot_token 授权范围、context token 生命周期、真实发送限制、超时但已送达，以及独立 DSH 模型登录/Agent 推理/模型触发澄清。真实 DSH 的控制协议验证已完成，微信与模型端到端未通过验收前不声称可交付的在线服务已连通。
