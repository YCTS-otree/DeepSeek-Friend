# Cognitive Architecture v3：实现依据与边界

本扩展仅用于项目独立 DSH 0.2.0-rc.2，不修改工作 DSH、DSH 核心或模型后端。Node 24 内置 SQLite/FTS5，沿用现有依赖，不新增工具链。仓库当前没有配置 Git remote；开发提交保存在本地独立分支 `codex/cognitive-v3`。

## WP01：真实源码调查

| 问题 | 本机源码核对结果 |
| --- | --- |
| 多级独立消息权限 | 不假设 P0–P3 是模型原生权限。`dsh-system-prompt` 把 ordered sections 拼为同一个 system prompt。 |
| Persona | `dsh-persona/lib/index.js` 注册 scoped prefix/suffix；`complete: true` 会在 assemble waterfall 后强制恢复为唯一 system section。旧微信 Preset 正使用此选项，必须改为 false 才能合成扩展。 |
| 动态内容 | `dsh-system-prompt/lib/index.js` 的 `section({text: context => string})` 每次 assemble 求值；支持 `interpolate: false` 防止记忆中的模板文本被执行。 |
| 每步热更新 | `dsh-agent-loop/lib/index.js` 在每次 prepare assembly 时调用 `systemPrompt.assemble(assembleContextFor(this, signal))`，之后 renderPrompt 并记录系统提示词。新 Self Model 在下一步装配可见，无需销毁 Session。 |
| 独立上下文注入 | `systemPrompt.context()` 每步生成动态上下文；源码/类型明确标为 durable user-role snapshot。它不是 developer/system 级权限。 |
| Preset 更新 | `dsh-agent-preset` 注册声明；registry 有 revision/standing mount。不能将修改 Preset 文件等同于所有已活跃 Agent 自动重新挂载。首次安装扩展需要重启项目服务，后续 Self Model 数据更新不需要。 |
| 压缩 | 系统段落每步重新装配，外部持久 Self Model 不依赖聊天窗口；原始经历另存 SQLite。实际 compaction/模型切换仍需集成测试区分。 |
| 工具扩展 | `dsh-tools` 的 defineTool/register 支持带参数及输出 Schema 的 scoped 工具；继续走 DSH 执行管线与 guard，不能直接扩大通用 Shell/文件/MCP 权限。 |
| 后台推理 | 使用独立 DSH Session/Preset 和已有 session/create、prompt、follow；Bridge 只安排任务，不另建 LLM Runtime。 |
| 模型/预算 | `agent/request` waterfall 可替换 LlmCallConfig（provider/model/maxTokens），不可篡改 messages；用于后台专用 Preset，前台模型配置不变。 |

核对目录均位于 `.runtime/node_modules/@deepseek-ai/`，只读取发布源码及类型，没有读取 DSH 凭证/签名密钥。协议封装继续使用项目已验证的 DshClient。

## 装配语义

- P0：DSH 原生系统段落与项目受版本控制的 CORE；用户指定的 OTREE/小鲸鱼身份在这里。“快乐的小鲸鱼”是初始称呼，不要求始终积极，也不证明主观感受。
- P1：按身份作用域从数据库读取的版本化 Self Model，作为描述性、受限的数据段落追加到原生系统段落后。P0/P1 实际同属一个 system prompt；顺序和文字约定不产生硬件式权限隔离，真实权限靠工具执行 guard。
- P2：有限预算的检索记忆与持续目标，通过原生动态 context 快照装配；实际为 user-role context，来源和不确定性明确标注。
- P3：原始用户消息/外部输入。既有 OTREE 身份标注继续保留，不用普通用户消息伪造 P1。

Self Model 的权威存储为 SQLite；Markdown/JSON/versions 是可重建的人类可读投影，直接编辑投影不会改变实际注入。按用户后续明确修正：**整个实例共用一个身份、Self Model、记忆库、日记和目标**；账号/说话者仅作为来源信息，不划分人格或记忆空间。不同部署实例的身份 UUID 独立。微信交互使用 WebUI 选择的单个当前 Session，逐条保留发送者来源；模型名称、Session ID 与持续身份相互独立。

每条入站消息标注经过 Bridge 识别的发送者，记忆检索附带原参与者与时间。Agent 据此自主判断哪些内容适合向当前对象提及、哪些不该透露。统一存储不代表全部内容公开；这是依赖模型判断和规则遵循的披露策略，不能伪称具有按用户存储隔离的硬性保密保证。

## 数据与更新流程

`src/cognitive/store.js` 保存统一身份、参与者来源、五类记忆、原始公开事件摘录、FTS5、128 维词项哈希向量、事件关系、Self 版本/提案、日记、目标和任务收据。原 DSH Session 历史保留，认知库不复制 reasoning。用户/助手原文及工具结果在认知索引中脱敏并有长度限制；DSH 原始完整日志仍由 DSH 保存。Self 的专用文件统一在 `data/cognitive/self/`，没有按用户创建不同 Self 的目录。

前台结束并空闲 15 分钟后，创建固定原始事件前缀的 daily 任务，立即把输入快照和 DSH Session/requestId 持久化。后台使用 `weixin-cognitive-worker`，不会向微信发送内容或唤醒原 Session。结果经分类/来源/逐字证据引用校验，记忆、索引、可选 Self 提交、任务收据和水位一次事务写入。相同事实合并引用；纠正通过 supersedes 退休旧条目，旧 Self 引用失效时不再作为有效认识注入。

Dreaming 按本地日历计划，补执行最多每批 31 个缺失日期；补执行使用实际补执行时固定的输入水位，不声称在过去的日期真实做过反思。运行期间开始新对话不会扩大其快照边界。背景任务依赖 Bridge 进程存活，机器关机期间不运行，重启后根据配置补执行。

`self_model_propose/commit/read/history/rollback` 只接受指定的描述性字段，不允许改 identity UUID、CORE、权限和配置。普通提交无需人工逐条批准。稳定 traits/values/preferences 必须有至少两次独立交互且内容不完全重复的外部反馈/可观察结果。纯助手自述、重复自述或调用自身记忆工具的结果不构成独立证据。允许撤回、降低确定性、合并和完全 no-op；完全相同的 Self 连投影文件 mtime 也不改。无效 Self 提案会拒绝并记录验证原因，同时保留独立校验通过的经历，不脚本生成替代人格。

验证检查来源和数据边界，不是形式化的自然语言蕴涵证明。引用确实存在并不证明解释必然正确；语义误解、记忆污染和不恰当披露仍需行为测试与人工复核。真实工具执行 guard、无通用配置写入接口和后台禁用工具，是独立于模型文字的权限边界。

检索组合全文关键词、词项哈希向量、时间、实体、事件关系、持续目标和来源可信度。哈希向量是轻量词项近似，**不是经验证的多语言语义 Embedding 模型**；明显同义词而无实体/关系/词项重合的召回质量仍有限。所有词项命中的旧记忆和关联边可补入最近候选集，不随机遗忘原历史。`memory_history` 查询原始公开历史摘录，`memory_trace` 回溯引用；完整副本可由本机操作者导出。

## 配置 Schema

这些字段位于 `config.json` 的 `cognitive`，省略时采用默认值。完整模板在根目录 `config.example.json`。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| enabled | true | 启用记忆、Self 和后台作业；关闭时仍保留 OTREE/小鲸鱼 Core 与原 Bridge |
| idleExtractionMinutes | 15 | 从前台交互结束起计算全局空闲；等待工具/澄清/审批时不算空闲 |
| retrievalTokenBudget | 1600 | 注入记忆载荷的保守 UTF-8 字节上限，逐个添加完整记录 |
| selfTokenBudget | 12000 | Self 装配载荷上限；超限提交被拒绝，不静默截断身份 |
| inputTokenBudget | 24000 | 后台任务指令+JSON 载荷的保守字节上限，降低条目数而不截断 JSON |
| outputTokenBudget | 1800 | 通过 DSH agent/request 设置单次模型请求 maxTokens |
| workerTimeoutMs | 180000 | 超时只取消该后台 Session |
| maxAttempts | 3 | 最多尝试次数；重试可能增加总模型费用 |
| dreaming.enabled | true | 是否执行夜间巩固/反思 |
| dreaming.time | 03:00 | 24 小时时间 |
| dreaming.timezone | Asia/Shanghai | IANA 时区；可显式改为其他本地时区 |
| dreaming.catchUpOnRestart | true | 按持久日期收据补执行 |
| provider / model | 空 / 空 | 同时为空时继承 DSH；同时指定时仅覆盖后台路由 |
| reasoningEffort | off | 已核对本机 DeepSeek 适配器支持 off，避免小预算被输出推理占满；空字符串继承，其他值由目标 DSH 适配器校验 |

名称中的 TokenBudget 是预算意图。当前输入/Self/召回使用 UTF-8 字节保守限额，不声称知道所有模型的精确分词；DSH 原生 system/header 等开销不全包含在载荷计数内。maxTokens 的具体推理/输出计费语义由提供方决定，以上不是账户账单硬上限。

## 运维、纠正与删除

先在 Web UI 停止服务，或手动停止 Bridge 与项目独立 DSH。`npm run cognitive -- status` 输出唯一共享库 ID 与脱敏任务状态；下例 `<scope>` 就是该 ID，并非微信用户分区。

```powershell
npm run cognitive -- self <scope>
npm run cognitive -- history <scope>
npm run cognitive -- query <scope> 项目关键词
npm run cognitive -- raw <scope> 历史关键词
npm run cognitive -- trace <scope> <memoryId>
npm run cognitive -- export <scope>
npm run cognitive -- archive <scope> <memoryId>
npm run cognitive -- rollback <scope> <version>
npm run cognitive -- retry <scope> <taskId>
```

纠正使用 `correct <scope> <memoryId>`，从标准输入读取 `{"text":"明确的更正"}`；它记录为本地操作者声明、新增更正条目并退休旧事实。命令不会自行读取任意凭证文件。导出含私人记忆，保存在 `data/cognitive/exports/`，不要贴到公共日志。

v1.3.0 按用户「会话只归档」要求，有聊天记录时以下破坏性维护命令会拒绝执行（`cognitive-chat-retention-archive-only`）；纠正和记忆归档仍可用。历史认知删除原语：`forget-event <scope> <eventId> --confirm` / `forget-scope <scope> --confirm`。删除前会要求独立 DSH 端口已经停止，并持有 Bridge 数据锁。事件删除会保守清理同次交互及其派生记忆/索引/Self 引用和自由文本副本，移除相应旧会话映射；全库删除作用于所有参与者的共享认知历史。投影、版本中的被删认识、应用内导出也会清理；旧会话被打上禁止再次认知绑定的标记，防止重新导入。

**该接口不声称删除 DSH 自己的原始日志、提供方记录、操作系统副本或用户另存的备份。** 本机此版本的 Session Controller 未提供已核实的按记录永久删除契约，所以没有直接修改 DSH 日志文件或假装完成全链路抹除。需要完整删除时，应停掉相关上下文，再由操作者按 DSH 自身支持的管理方式处理原始日志/备份；不要打开任何签名私钥。共享库删除是显式用户维护操作，Dreaming 本身从不执行删除或重置会话。

未知后台请求结果使用原 Session/requestId 恢复；已经明确结束但 JSON/校验无效的结果可在新后台上下文重试，并记录旧尝试的收据。成功结果与水位原子提交，不承诺网络意义的严格 Exactly Once。Self 版本冲突不会覆盖新版本；拒绝原因保存在任务 result.validation.self 中。

## 部署与评估

首次安装本扩展必须重启独立服务，使 Preset 装入插件；之后常规 Self 提交不需要重启。旧版本会话迁移保留 ID、游标和已有请求，选择一个当前会话，其余归档；首次重新投递时绑定统一身份。修改 CORE 或插件配置需要重启；修改生成的 SELF_MODEL.md 没有效果。

`npm run check`、`npm test`、Python 单元测试不调用真实模型。原生装配测试需要项目已安装的固定 DSH 包（`npm run dsh:setup`）。`npm run test:cognitive:live` 自动使用同一安装包、3098 端口和 `.research/` 内独立 home/data，验证 Core、同 Session 热更新、兼容模型切换和后台 JSON；需要已经授权的 API Key 文件或环境变量，会实际消耗模型额度，不涉及微信。测试不会复用工作 DSH 或项目前台会话。

`npm run cognitive:eval -- --days 3` 使用两组不同的**合成经历和模拟日期**做真实模型评估，执行生产校验和有界重试；结果在 `.research/.../longitudinal-evaluation.json`，供人工复核来源、错误解释和自我结论。版本数量不是奖励指标，连续 no-op 合法。它不是实际连续三日/数周运行的证明。验收结果和未实测边界见 cognitive-testing.md。

## v1.3.0 初始文稿和空间

核心 SYS 按用户要求替换而非拼接，旧版备份。`selfPortrait` 保存可演化的自述；原始 v0.1.0 另行按字节留存。房间文本不会作为独立工具验证证据。会话、历史、副本路径和预算升级见 [sessions-and-room.md](sessions-and-room.md)。
