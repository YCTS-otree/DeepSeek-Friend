# 兼容性边界

记录日期：2026-10-22；Bridge：1.1.0。

| 对象 | 依据 | 状态 |
| --- | --- | --- |
| DSH 0.2.0-rc.2 | 项目独立安装、本机已安装包源码与真实协议测试 | 已核对 Cookie / RPC / mux / Session / inbox / Preset |
| DSH 0.1.7 及更早版本 | qq-bridge 的适配说明与源码 | 不作为支持目标；不使用旧 `value.queues` 控制数据或旧消息事件 |
| 后续 DSH 版本 | 未验证 | 不自动升级；先更新兼容测试，再修改独立锁文件 |
| iLink 当前官方源码 | 锁定 Git 提交与协议文档 | Mock 断言请求形状；真实扫码和投递尚待验证 |
| Windows / Node 24.19.0 | 实际本机 | 已运行自动化与独立 DSH 协议测试 |
| Python 3.10.11 / 本地 Web UI | 标准库 HTTP + 现有 Node QR 编码器 | 真实独立 DSH/iLink 二维码启停及浏览器布局验证通过；不增加 Python 依赖 |
| Linux / Node 24 | 跨平台设计 | 尚未实机验收，尤其是 Linux 凭证权限及账号锁 |

## DSH 适配

独立安装清单对传递依赖设置两个显式 npm overrides：`@modelcontextprotocol/client=2.3.0`、`fflate=0.8.3`，并提交完整 lockfile。初始 DSH 0.2.0-rc.2 依赖树的审计归因到 12 个包；实际问题位于 MCP OAuth/跨域重定向和旧版 fflate ZIP 解析。修复依据为 [MCP OAuth 公告](https://github.com/advisories/GHSA-6qxp-vccf-f47h)、[MCP 重定向公告](https://github.com/advisories/GHSA-6prh-2h8m-c8cw)、[fflate 公告](https://github.com/advisories/GHSA-px8p-9vwx-vf98)。重新安装、重启独立 DSH 并重跑兼容测试后，Bridge 与独立 runtime 的 npm audit 均报告 0 个已知漏洞。这是该时间点的依赖检查结果，不代表安全保证；默认不挂载 MCP/媒体功能，真实 MCP OAuth 仍不属于本版验收范围。

`GET /?token=...` 采用服务端正式 launch-token 交换流程：要求 302/303 和 authority 绑定的 `dsh-auth-*` Cookie，不跟随重定向。RPC 与 WebSocket 都携带此 Cookie。

RPC 是 `POST /api/<namespace>/<method>`，外层 `{type:'client-request',rpcId,method,payload:{args}}`，结果外层为匹配 rpcId 的 `server-response/result`。`session/create,prompt,cancel,page,projections,updateQueue` 的 args 使用 `request` 包装；`session/list` 使用 `_request`；`agentPresets/list` 不带参数；`agentPresets/read` 参数直接为 `agentPreset`；`$events/result` 参数直接为 `clientId,eventId,outcome`。

`session/prompt` 使用持久化 `requestId`、`mode:'queue'`、文本 content 和明确时区。当前 DSH 将 requestId 记录为用户消息 `source.rpcId`，并在 inbox/历史内检查重复。只在这一代已验证协议上重用相同 requestId，不推断未来版本仍具有相同幂等性。

`/api/remote.mux` 是 WebSocket 复用流。客户端发 `open/streamId/endpoint/payload`；下行包含 `item/end/error`。每个账号 Bridge 打开 `$events` 和各个 `session/follow`。follow 请求地址为 `{kind:'session',sessionId}`；开场 `snapshot` 带 records、cursor、projections，增量为 `{type:'event',event}`。模型输出只取持久化的 `assistant/message.data.message.content` 中的 text，并以对应请求所在 turn 的 `turn/end` 收尾。

新版本 inbox 位于 `session/projections.values.inbox['next-turn'|'next-step']`，队列项有实际 MessageId。取消前先 `session/updateQueue` 移除，再 `session/cancel`。不把取消当作清队列，不依赖 archive 副作用。

Preset 注册是 Cordis `@deepseek-ai/dsh-agent-preset` 声明，不是旧 `.agent-presets/` 目录扫描。启动器在自己的 home 中初始化 `weixin` profile，应用项目 patch。自定义策略模块以 **file URL** 交给 ESM Loader，兼容 Windows 盘符；插件加载失败会使 Preset 不可用，Bridge 拒绝启动。

DSH Cookie 仍代表本机操作者，没有在此版本验证过仅会话级专用 API Token。Bridge 通过独立实例、有限 RPC 用途、白名单、预设工具隔离控制暴露范围，不能声称服务端凭证本身具有细粒度权限。没有实现读取签名私钥或离线伪造 Cookie 的兼容路径。

1.0.1 增加 API Key 文件启动接入。已核对 DSH `dsh-llm-deepseek-api-key` 的 provider=`deepseek-official` 与 `DEEPSEEK_API_KEY` 凭证引用；独立默认模型为 `deepseek-flash`。用用户明确确认类型的 API Key，通过真实 `session/prompt` 和事件流验证了 Agent 正常完成及预期回复，未直接绕过 DSH 调模型。

## iLink 适配

参考客户端发送 `iLink-App-Id`、数值编码 `iLink-App-ClientVersion`、`AuthorizationType: ilink_bot_token`、随机 uint32 十进制字符串的 base64 `X-WECHAT-UIN`，以及 `base_info`。登录走 POST `get_bot_qrcode?bot_type=3`，带 `local_token_list`；GET `get_qrcode_status` 可带验证码，处理当前源码中的全部登录状态。

长轮询发送 `get_updates_buf`，不启用废弃 `sync_buf`。uint64 消息 ID 通过 Node 24 JSON reviver 原始字面值保留，不先舍入为浮点数。入站文本接受 NEW(0)、FINISH(2) 或省略 state；不转发生成中的消息。

回复请求完整保留官方实现中的空 `from_user_id`、收件人、固定 client_id、BOT=2、FINISH=2、TEXT=1、context_token，以及入站适用的 run_id。`getConfig` 与 `sendTyping` 有独立客户端实现与 Mock 校验；MVP 默认不展示输入状态，以免增加故障面。

`-14` 是已知会话超时码。HTTP 429 保留同一 outbox 身份退避；未知业务错误不猜测重试合法性，发送网络/5xx/无法解析结果统一保守隔离。未假设服务端支持 client_id 去重、主动发送、固定文本长度上限或任意 IDC 主机。

协议文档说明的是客户端行为，不能证明最小请求或完整服务端契约。当前通信身份沿用所核对的官方客户端字段，真实账号接入可能需要腾讯端新增字段或授权；需通过扫码与投递实测确认。
