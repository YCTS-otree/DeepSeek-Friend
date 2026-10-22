# 测试与验收报告

日期：2026-10-22；Bridge 1.0.2；Windows；Node 24.19.0；独立 DSH 0.2.0-rc.2（含兼容性文档中记录的安全依赖覆盖）。

## 已执行结果

| 检查 | 结果与范围 |
| --- | --- |
| `npm run check` | src、scripts、tests、DSH 策略模块的 JavaScript 语法检查通过 |
| `RUN_DSH_PROTOCOL=1 npm test` | 47 项通过，0 失败、0 跳过；其中 46 项为本机自动化/Mock、1 项连接真实独立 DSH；本次以实际 Administrator 账号运行 |
| 默认 `npm test` | 同一套测试，真实 DSH 用例在未显式启用时跳过，不伪报成功 |
| Bridge `npm audit --omit=dev` | 0 个已知漏洞 |
| 独立 runtime `npm audit --prefix .runtime` | 修复依赖锁定后为 0 个已知漏洞；初始为 5 high / 7 moderate（包括向上归因），修复记录见 compatibility.md |
| DSH 锁文件 `npm ci --prefix .runtime --dry-run` | 已验证锁文件可被 npm 接受；实际独立安装并成功启动 |
| 独立启动器首次启动 / 再启动 | 均已执行；只在首次初始化 profile；真实持久空 Session 在重启后复用 |
| 真实 DSH + DeepSeek 模型最小验证 | 用户确认 API Key 类型后，由启动器在内存加载；通过 DSH Session 提交测试输入，收到 completed 与预期文本。独立验证，不计入默认自动化数量，不输出凭证或推理 |
| 实际用户跨账号启动回归 | 在 Administrator 账号重现旧版 data-acl；修复后验证 data/home 可写、独立 DSH ready、DPAPI 连接恢复、doctor 和 Bridge 获取真实 iLink 二维码通过。二维码内容未进入测试输出；未手机扫码 |
| 参考源码 | 两个真实 Git clone，经本机 10808 代理；提交及 blob SHA 见 reference-sources.json；上游工作区无修改 |

## 自动化覆盖

- **完整 Mock A/B**：本机 HTTP iLink poll → 真实 DshClient HTTP RPC / WebSocket mux → Engine → SQLite outbox → HTTP iLink send；批次重复消息去重，三条输入共用同一 DSH Session，三条文本回复有正确上下文和独立 client_id。
- **入站持久化**：inbox 与 cursor 一次事务，重开数据库恢复，真实子进程以未提交事务突然退出后回滚；缺失 ID/上下文和坏结构隔离，不阻塞同批合法消息。
- **会话与账号边界**：不同用户具有独立 Session 和派生工作目录；切换活跃账号后旧账号任务不提交；未经授权、群聊、机器人消息不进入 Agent；重置释放旧订阅。
- **DSH 故障**：RPC 网络超时后保留相同 requestId/sessionId；推理期间新消息排队；快照与分页回补、事件去重；DSH Session 明确丢失进入 review；Agent 错误和 turn 超时可控取消。
- **回复**：多段文本聚合、取消状态、只保留 text，不发送 reasoning/assistant-stream/tool result；outbox 与任务结束原子写入。
- **微信故障**：发送结果未知只尝试一次，保留原 client_id；sending 崩溃恢复为 unknown；429 重试保留原请求且阻止后续分段越过；-14/失效授权立即终止 poll。
- **扫码协议**：官方 QR POST body、GET common headers、扫码确认、验证码、过期刷新、already-bound 无凭证拒绝、跳转精确域名限制、取消。
- **权限与交互**：默认 DSH restrict/guard 阻止 Shell/写入/MCP；不同用户不能批准；必须有在线 client、原调用及唯一 audit ID；重复审计歧义拒绝；完整操作提示未确认投递不允许批准；断线令 pending 失效；澄清答案结构校验；等待回答时普通消息保留队列；取消先清 inbox。
- **平台保护**：Windows 账号命名管道锁和 data SQLite 锁；DPAPI 假凭证往返，磁盘无假凭证的明文；日志忽略任意敏感字段；启动配置拒绝工作 DSH 3080。
- **API Key 入口**：默认与自定义文件、BOM/换行、原始环境不被修改、显式缺失和格式/大小不合法拒绝；自动化仅使用假凭证，真实凭证不进入测试代码或输出。
- **Windows ACL 回归**：数值 SID、显式项目所有者权限、重复检查、禁止宽泛用户组、文件写入，以及拒绝访问错误码和原始 stderr 不泄漏；真实用户普通权限下的启动另有上表实测。

## 真实 DSH 协议测试的边界

真实用例验证 Cookie 鉴权、Preset 查询和文档、session/create 显式 ID 创建/采用、跨启动复用固定 protocol-test Session、projections 的 inbox、remote.mux `$events` ready、follow snapshot、cancel 与不存在 Session 的 null 结果。

上述协议自动化使用本项目 `.runtime/home`、3088 和本项目工作根目录，不读取工作 DSH 的凭证，不连接其 3080，不调用 LLM，也不接触真实微信。测试产生的少量 `protocol-test-*` 空 Session 保留在独立 home 中。额外的真实模型最小验证单独创建 `model-smoke-*` Session，只通过 DSH 调用模型。

没有把模型生成、真实工具执行或微信送达算进这个真实协议用例。Linux 也没有实机测试。

## 尚待真实账号验收

| 场景 | 用户环境中的步骤 | 当前状态 |
| --- | --- | --- |
| A 首次使用 | 独立 DSH 配置模型 → 扫微信二维码/手机确认 → 发“你好” → 核对 Session 与微信回复 | 独立 DSH 真实模型最小调用通过，待微信授权 |
| B 多轮 | 连续发三条相关问题，在独立 DSH 页面核对同一 Session 与模型对上下文的利用 | Mock 通过，真实微信多轮仍待验收 |
| C 重启 | 分别重启 Bridge 与独立 DSH，核对微信授权、游标、Session 映射和历史回复不重播 | SQLite/恢复/DSH 协议通过，真实聊天待验收 |
| D 故障 | 断开 DSH、网络超时、重复消息、微信撤销授权；核对 unknown、队列和无重复执行 | 自动化通过，平台真实行为待验收 |
| E 权限 | 微信尝试 Shell/写文件；默认 Preset 不提供能力；若另建受审工具，核对一次审批和过期/跨用户拒绝 | 默认隔离/审批 Mock 通过，模型触发流程待验收 |

真实验收时不要在记录中保存 bot_token、Cookie、二维码内容或完整启动 URL。发送超时而实际可能成功的场景先核对手机记录，再按 operations.md 人工处理 unknown。没有经验证的严格 Exactly Once 语义。
