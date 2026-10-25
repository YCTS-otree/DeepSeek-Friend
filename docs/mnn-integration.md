# DSF 1.12.0 / MNN 1.2.0 集成

## 运行边界

DSH 是唯一 Agent Runtime。MNN 提供记忆网络、分段 LLM Dreaming、Carryover 和 Adaptive Context Reconstruction；DSF 提供生命周期、排队、压力保护和安装门禁。没有第二套 Agent、模型调度器或 Basic Compaction 回退。

适配真实安装的 DSH **0.2.0-rc.2**。`ctx.tokenMeter.measure`、`ctx.llm.prepareCall/stream`、`agent.runMaintenance`、原生 Session/Surface 与 CompactionEngine 接口均已在实际包上测试。Inbox 的 prepend/wakeDriver 及恢复来源绑定是版本敏感接口，升级 DSH 后必须重新验收。

`vendor/dsf-mnn/SOURCE.json` 记录上游基线 `7fcccbc`、集成版本及逐文件 SHA256。MNN 自身许可由维护者决定，未擅自改为主仓库 MIT；算法/第三方说明见 vendor 下的 THIRD_PARTY_NOTICES.md。不改官方 node_modules，不管理工作 DSH 3080。

## 一个记忆网络

正式数据位于 `data/cognitive/mnn/memory.sqlite`，所有正式 Session 使用同一个 Scope。`native_sources` 将 Session + native seq 映射到全局证据序号，防止不同会话相同 seq 覆盖。来源 URI 保留原 Session/seq。

旧 cognitive.sqlite 保留原始记录、Self 版本及审计；已有活跃记忆一次性导入 MNN。启用后旧 Daily/Dreaming 调度停止，Agent 的自动召回、主动 recall、关联、目标和新 Dreaming 共用 MNN 图。暂停后台仍读取同一 MNN 库，不切回旧长期记忆。独立测试空间继续与正式数据隔离。

Self Model、最初 v0.1.0、Core SYS、小房间、模型推理日志及聊天历史均保留。MNN 可以产生反思数据，但正式 Self commit/rollback 工具暂时关闭；没有每日强制变更。

空闲默认 15 分钟，运行分段语义记忆提取并立即持久化，**不会因此重建活动上下文**。夜间默认 Asia/Shanghai 03:00，执行巩固和 ACR。已知错过日期会补执行一次，首次安装不虚构过去的计划。压力保护可以提前触发同一条 Dreaming Pipeline。

## Context Pressure Guardian

| 状态/阈值 | 行为 |
| --- | --- |
| NORMAL，低于 85% | 正常执行 |
| REST_PENDING，达到 85% | 系统装配段提示“你需要休息一小会了，下次回复后会进行小憩。”；允许安全回复完成，再进入维护 |
| REST_REQUIRED，达到 95% / 下一请求预测越界 | 拦截请求，保留原 Inbox 和任务；安全边界维护；可安全装配时提示“你必须休息了。” |
| DREAMING | 固定快照，MNN 分段理解、持久化长期记忆和 Carryover |
| RECONSTRUCTING | 检查来源版本，官方 Provider 预算预检，原生 checkpoint 提交及重测 |
| NORMAL，低于恢复水位 60% | 唤醒原 Inbox，保持同一个 Session |
| RECOVERY_PENDING / REST_FAILED | 保存失败和工作水位，最多三次指数退避；固定上下文本身过大立即停止，不无限重试 |

测量取原生 meter、官方 tokenizer 对中文/JSON/实际装配内容的计数及 Provider Usage 上界，再加输出预留和安全余量。媒体没有可靠定价时不放行；不能只靠字符数估计。重建前用真实 Provider 请求验证 envelope，成功后为新 Surface 校准旧用量锚点。

Soft/Hard 提示来自 DSH system-prompt 装配段，不冒充聊天用户。自动召回的 P2 记忆进入 DSH 原生 `user/runtime-context` 快照，使用不递归展开的变量承载不可信文字；Self 仍为系统段中位于 Core 之后的数据。Checkpoint 使用 DSH 原生 `compact-checkpoint` 来源，其 API 角色是 **user**；这是受支持的摘要载体，不是独立高优先级指令。如果紧急暂停时原请求已提交且 Inbox 为空，恢复任务通过内部 `mnn-runtime` 用户角色消息绑定 `resumesRpcId`。它不冒充 OTREE，也不改变 SYS 权限。

每个 Session 有原生维护互斥、持久化 lease 和 run_id。工具调用/结果边界必须配对，入站消息在维护期间排队；记忆落盘失败绝不提交 checkpoint。原始事件只追加，不删除。成功收据只在同一次中断恢复时复用，不能跳过下一次 Dreaming。

## 安装、启停与正式整理

复用现有 Python 3.10+、Node 24+、tokenizers、Jinja2 和 pytest。无新 venv/运行时。Tokenizer 使用已有经 SHA256 校验的官方资源，不从未知地址自动下载。

将既有词表放在 `.research/mnn-v120/tokenizer/`（只读资源，按锁文件校验，不随源码分发）。先在独立测试实例运行真实 Provider 验收（会产生 DeepSeek API 费用；默认无通道）：

```powershell
node scripts/mnn-native-canary.mjs --live
# 使用上一步输出的新目录；审计只读重开该测试 Session。
node scripts/mnn-audit.mjs .research/mnn-v120/native-<id>
python scripts/mnn_validate.py --native .research/mnn-v120/native-<id> --retrieval .research/mnn-v120/retrieval-<id>
```

检索报告由 MNN 子项目 `scripts/evaluate_production.py` 对固定题集和克隆库生成。真实 Provider 三轮与跨日 Mock 都必须通过。验证脚本保存日志与源码摘要；源码变化会使旧门禁失效。最终门禁所绑定的三轮真实 canary 与关键运行源码摘要完全一致；较早 canary 后的 Windows 工作进程树取消修复也已用独立测试和全 profile smoke 复核。

在关闭本项目 Bridge/DSH 后，对原 Session 一次性整理：

```powershell
python scripts/mnn_admin.py prepare --session <原会话UUID> --tokenizer <已有词表目录>
```

该操作会将正式历史发送到配置的 DeepSeek 官方 API，必须有相应用户授权。它持有离线锁，先创建并校验 `.DSF`，再导入旧记忆、分段 Dreaming、提交原 Session checkpoint、只读重开校验。不会提交新的聊天、执行 Shell/外部工具或自动重放 Inbox。失败保留原始事件与收据，不回退 Basic。

启用运行时（仍需停服，且再创建一份验证过的 DSF）：

```powershell
python scripts/mnn_admin.py install --tokenizer <已有词表目录>
python scripts/mnn_admin.py status
python scripts/mnn_admin.py pause
python scripts/mnn_admin.py resume
# 配置可通过 CLI 或 WebUI「运行控制 → MNN 与小憩保护」保存
python scripts/mnn_admin.py install --soft 85 --hard 95 --resume-watermark 60 --idle-minutes 15 --dreaming-time 03:00 --timezone Asia/Shanghai
```

WebUI 更改统一走 ArchiveManager.feature：停 Bridge/DSH、备份、完整校验、写配置，然后仅恢复原来运行的进程。备份失败不得启用。只有本项目进程可被管理。

## 故障与回滚

`mnn-rest-failed` / `mnn-provider-budget-unverified`：先检查本机 runs/provider 收据与网络；不要反复发送消息。修复原因后停服，执行：

```powershell
python scripts/mnn_admin.py retry --session <UUID>
```

`mnn-insufficient-headroom-or-fixed-context`：固定 SYS/Self/工具和不可压缩尾部超出恢复水位；应调整配置或保留尾部策略，不能无限压缩。媒体尾部仍需进一步预算适配。

快速止损用 `pause`，其含义是停止 MNN 后台；压力过高时仍阻止越界请求。退回完整旧架构必须停止服务、切回旧代码并恢复匹配 DSF。DSF 回滚继续三次各至少 3 秒的确认，并先备份当前状态：

```powershell
python scripts/mnn_admin.py rollback Archive/<备份名>.DSF
```

整份恢复、分类型兼容：DSH context 由实际 DSH 版本控制；cognitive-state 当前为格式 3，旧格式先在暂存目录迁移。共同 Self/房间/Prompt 不因应用版本变化而强制转换。格式 2 中已启用但没有数据代际的 MNN 图谱要求显式干净重建，禁止直接重标；接入前无 MNN 的快照可安全迁移。旧快照不自动启用 MNN。详见 [后台来源隔离与专项重建](mnn-clean-generation-20261025.md)。

## 已知限制

- 检索仍为 FTS/词项哈希与有界关系图；不是已验证的神经语义 Embedding。条件式 PPR 只使用直接事实检索的剩余预算。
- 8 题真实历史固定集仍有 G5 来源覆盖缺口，没有宣称整体质量提升或统计优势。复杂冲突有版本化 supersede 接口，但 LLM 自动纠错仍需人工抽查。
- 三轮真实小憩不是连续多天在线运行；跨日期、故障注入、并发和重启主要由自动测试覆盖，Linux 实机及长期高负载尚未验收。
- 所有来源是数据；引用与来源验证能减少错误固化，不能证明已完全解决 Prompt Injection / Memory Poisoning。不要把图中模型推断当成已验证事实。
- 原始历史本机保存，收据包含私密上下文，仅供本机审计，不放 Git/Release。保留权限和批准机制，不保证严格 Exactly Once。

启用 MNN 后，旧 cognitive CLI 的 query/raw/trace 已转到 MNN；correct/archive/forget/export/retry/Self rollback 暂时明确拒绝，避免只改旧库却宣称修改成功。整份导出仍用经过校验的 DSF。逐项遗忘、正式记忆管理与自动冲突裁决仍需专门接口后续完善。原始全量 export 超过 128MiB 时会停止维护而非截断，超长期会话的增量传输仍待完善。夜间触发按配置时区，部分底层收据日期标签仍为 UTC。
