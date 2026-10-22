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

Self Model 的权威存储为 SQLite；Markdown/JSON/versions 是可重建的人类可读投影，直接编辑投影不会改变实际注入。按用户后续明确修正：**整个实例共用一个身份、Self Model、记忆库、日记和目标**；账号/说话者仅作为来源信息，不划分人格或记忆空间。不同部署实例的身份 UUID 独立。微信 Session 仍按会话分别映射，以识别当前对象；模型名称、Session ID 与持续身份相互独立。

每条入站消息标注经过 Bridge 识别的发送者，记忆检索附带原参与者与时间。Agent 据此自主判断哪些内容适合向当前对象提及、哪些不该透露。统一存储不代表全部内容公开；这是依赖模型判断和规则遵循的披露策略，不能伪称具有按用户存储隔离的硬性保密保证。

后续实现、配置、操作和验收记录将随工作包补充到本文件。
