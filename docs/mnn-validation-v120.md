# MNN 1.2.0 验收记录（2026-10-24）

## 固定基线及隔离

DSF 基线 `1ffbc76`，分支 `integration/mnn-v1.2.0`；MNN 基线 `7fcccbc`，分支 `integration/v1.2.0`。MNN 原研究标签及 baselines/research-29d7de6 保持不变。

冻结源码 ZIP SHA256：`01b50b84522807b8d3cf3438c12b6e707eeaf6f079283d088bb142de136db254`。维护前正式 DSF `20261024-191704-08f0ebc6.DSF`，58 文件完整校验；正式数据未用于回滚演练。

## 实际执行结果

| 验证 | 结果 |
| --- | --- |
| DSF Node 自动测试 | 186 项：183 通过，3 跳过 |
| DSF Python unittest | 61 通过 |
| MNN Python pytest | 66 通过 |
| MNN 原生 Node 适配器 | 9 通过 |
| JS/MJS 与 Python 静态检查 | 通过 |
| 合成整份 DSF 恢复及恢复前备份 | 通过，正式数据写入 false |
| 独立 DSH 完整 profile 加载 | 通过，创建 weixin Agent；一条真实合成输入调用 memory_recall，已核验 user/runtime-context 和无 Self commit |
| WebUI | 隔离数据预览、状态/禁用态、未验收启用被拒绝；不操作正式开关 |

安装门禁逐项重新执行测试，日志、哈希和报告保存在本机 `.research/mnn-v120/validation-*/`。Windows owned-worker tree 取消测试在沙箱内曾因 taskkill 权限不足失败，获得操作测试自建进程的执行权限后通过；没有杀其他服务。

## 三轮真实 Provider / 原生 DSH

最终原始记录：`.research/mnn-v120/native-16c9d4ca-efa6-4a16-9a05-ef66870d0201/`。使用合成聊天、独立存储、真实 DeepSeek 官方 API，测试路由窗口 65,536（用于较快触发阈值，不代表模型正式容量）。真实 native tokenMeter、官方词表及 Provider 用量参与预算。

| 轮 | 整理前预测压力 | 整理后 | 累计 checkpoint |
| --- | --- | --- | --- |
| 1 / Soft | 86.12% | 17.14% | 1 |
| 2 / Emergency | 97.24% | 41.01% | 2 |
| 3 / Soft | 86.94% | 21.22% | 3 |

三轮保持同一个 Session `703ee9c7-509c-446d-99ea-a4a06214fbbb`。每轮原事件前缀完全相等，Carryover 存在，精确参数 `port=3099` 有证据召回。退出后官方持久化只读重开：3 个工具调用、3 个结果配对，pending input=0，末轮 completed，三个 checkpoint 保留。

其他成功运行 native-916557f8…、native-b1f85a8a… 的三轮也保留。全部失败样本保留：路由 catalog 窗口覆盖、Surface 顺序、旧成功收据错误复用、16K 配置无法达到 60% 水位、undefined 恢复 source 严格校验失败。对应修复已进入回归。没有删除失败目录或用后续结果覆盖它们。

## 跨日与故障

跨日期三天 Mock 验证旧/新记忆、Carryover、多次重建、精确参数、Self no-op、同 Session 与重复 Dreaming 无额外 LLM 调用。中断后保留事件、重新打开继续；变更源前缀拒绝接纳。

故障注入涵盖：持久化 JSON 原子 replace 失败保留旧文件；SQL 记忆已提交但 receipt 文件未写的中断不重复提取；重复事实计数非负；恢复过期 lease；有限失败退避；记忆未持久化禁止 checkpoint；工具边界与 Inbox 并发；新一次紧急保护不复用旧 success receipt；Windows 取消终止自建工作进程及其子进程。

## 检索质量，保留负面结果

真实 v1.1 冻结图与 8 题固定 gold，逐次克隆库、4KiB 注入预算；测量的是正确原始来源覆盖及排名，**不是模型答案准确率**。

| 变体 | 来源覆盖 | Source MRR |
| --- | --- | --- |
| v1.1 Evidence Hybrid | 7/8 = 0.875 | 0.504419 |
| 初次 v1.2 拼接方案（失败样本） | 6/8 = 0.750 | 0.490530 |
| 修复后的条件式关联 | 7/8 = 0.875 | 0.504419 |

失败样本 retrieval-9b427670… 保留。修复结果 retrieval-9334c4be…：完整保留原 Hybrid 上下文，只有显式关系问题且有剩余预算时补 PPR，不驱逐直接事实。G5 缺口仍存在，原始来源可查但预算内自动召回未覆盖。

v1.1 原图 Hybrid MRR 0.2708 低于早期冻结 0.3125 的负面结论未被抹去；该指标与上表 Source MRR 定义不同，不能混用为提升。样本少，PPR 未证明普遍优于 Hybrid。

## 正式部署记录

实际正式整理和激活结果另记在本机 `formal-*/report.json` 与 [部署状态](mnn-deployment-v120.md)。隔离通过不等于微信/QQ 端到端或多天生产验收。启用建议：先原 Session 一次整理，校验前缀、Self 与恢复水位，启用 MNN 后受控恢复；持续观察用量、延迟、召回来源与故障。禁止一次开放互联网或扩大渠道白名单。

正式入口首次在模型配置检查停止：隔离适配器 thinking=disabled 与运行 max 档位不兼容；未执行该次分段 LLM，保留 formal-975c0f61… 失败报告和前置 DSF。修复后对 1,000,000 窗口/max 路由作无网络元数据检查，并重跑上述三轮真实 canary。

正式第二次整理的 10 个 extraction chunk 已落盘，但巩固回复含未知 memory_ref，被验证层拒绝，未提交 checkpoint；formal-43dc88c4… 及收据保留。增加最多两次受来源约束的修复请求；无效引用仍不能提交，故障测试覆盖持续失败停止。

完整 Profile 的首个真实输入暴露缺少 sessions/llm/tokenMeter 的 Cordis 注入声明，已修复；随后一轮断言误把 P2 当作 system 角色，改按实际 user/runtime-context 核验。最终 runtime-355c28c8… 成功：调用 MNN recall、完成、无 Self 提交工具、无对外 emission。另加双花括号记忆不被再次模板求值的回归。

formal-16e13d42… 因修复后源码与旧 run-manifest 不同而安全停止，未重新提取或写 checkpoint。运行身份现包含实现摘要、提取/重建模式与当前任务，旧目录保持原样；跨模式复用已持久化语义结果和同 Session 历史，两个新增回归均通过。

最终门禁 validation-f70141e7…：静态、186 项 Node（183 通过、3 跳过）、61 项 Python、66 项 MNN、整份恢复和完整 Profile 真实合成调用全部通过。完整逐轮结果、精确比值和门禁摘要见 [结构化报告](mnn-validation-v120.json)。历史绝对收据路径不被跟随，搬迁恢复测试通过；原始提取证据和旧源码清单未被覆盖。

发布验证曾因 SOURCE 清单收录 pytest 缓存而失败；该自建失败包保留在 .research，未分发。清单已排除所有开发缓存，新增干净源文件清单回归；最终 Git 源码包重新校验全部 vendor 文件。正式运行代码与最后三轮 canary 完全一致。
