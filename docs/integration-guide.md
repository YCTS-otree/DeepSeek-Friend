# 共同开发与架构融合指南

## 先对齐运行边界

本工程是 DSH 的通讯和认知扩展，不是独立 Agent Runtime。融合时保留一个 Runtime、一个负责调用模型和执行工具的权威，避免两个循环同时消费同一条消息。先用标准源码包检查实现；朋友包用于对照实际状态和经历。

当前固定 DSH 0.2.0-rc.2、Node 24、DeepSeek-V41-Flash，QQ 网关 NapCat 4.18.41。不要直接复用上游旧版 Cookie 铸造方案或未知 Session API；`src/dsh.js` 和兼容性文档是实际适配依据。

## 推荐阅读顺序

1. `src/store.js` 和 `engine.js`：jobs/requestId、Session 固定、outbox、unknown/review。
2. `dsh/weixin.patch.yml`、`weixin-policy.js`、`cognitive.js`、`interaction.js`：Preset、guard、原生生命周期和扩展工具。
3. `src/cognitive/store.js`、`service.js`：统一身份、证据、可选演化、后台水位、检索与投影。
4. `contacts.js`、`qq.js`、`runtime.js`：真实作者和收件人的区分，特别是 `group:<群号>` 与作者 QQ 号不同。
5. `launcher.py`、`src/controls.js`、`web/`：本机操作者控制；不要把本机管理接口直接注册为 Agent 工具。

## 适合复用的接缝

| 目标 | 优先接入点 | 需要保留的约束 |
| --- | --- | --- |
| 新渠道 | 入站持久化和显式收件人，参考 QQChannel | 原消息 ID、真实作者、受众、授权、重复/未知结果 |
| 另一套长期记忆 | CognitiveService 的 bind/event/completed 与受控工具 | 原始来源、证据 ID、水位、作用域和 Self 版本 |
| 新工具/MCP | DSH Preset 与原生插件注册 | 注册期与执行期权限；不让 Self 自行授予能力 |
| 新 Prompt 组合 | 原生 systemPrompt.section 与动态 context | 保留真实角色语义，每步装配，不用 user 消息冒充 system |
| UI 管理 | controls + 启动器 IPC/认证路由 | Cookie、Origin/Host、CSRF、动作白名单和回环监听 |
| 迁移/备份 | DSF 或经过校验的只读导出 | 停服务、SQLite backup、版本匹配、不携带原登录密钥 |

## 不建议直接拼接的内容

两个实例的 Self identity、记忆 evidence ID、Session ID、任务收据、原始事件序号和工具审批 ID 都有各自含义。不能简单覆盖数据库、拼接压缩日志，或把两个 identity UUID 改成同一个就宣称已经融合。

先保留两份不可变输入；选择主身份及其历史，给导入实例加来源标签；以明确规则映射事件和证据，再导入语义记忆。保持原始记录能回查，不把助手叙事升级为事实。当前仓库**未实现跨实例一键合并器或跨路径自动迁移器**。

## 朋友包的启动检查

- 原始 SYS、Self v0.1.0 和当前 Self 保留，它们仍属于 OTREE 的这只小鲸鱼，不是朋友自己的空白实例。源码中的可信 QQ 号也保持原样；改身份须明确修改与测试，不能只改昵称。
- 包不含 API Key、签名密钥、Cookie、微信/QQ 登录状态。朋友使用自己的 Key，重新授权账号。
- 默认关闭渠道、清空群启用清单、暂停前台并关闭认知后台；先研究历史，再明确恢复调度和实际外部投递。没有自动删除或清空聊天。
- 原始 Session 桶名、部分文件绝对路径会保留。放到不同路径/系统前检查 `images.file`、工作目录、Preset 文件 URL 和原 Session；启动脚本重新生成运行配置，但不保证自动重定位全部历史。
- 不要覆盖自己正在用的 DSH home。先在单独项目目录和不同端口测试；本项目仍拒绝 3080。

## 回归基线

运行 `npm test`、`npm run check` 与 Python unittest。重点核对共享 Session、来源冒充、私聊/群目标、未知投递不重放、Prompt 热更新、Dreaming no-op、证据撤回、Self v0.1.0 完整性及测试空间隔离。真实模型与手机端验收单独记录，不以 Mock 替代。

源代码、文档、许可证、锁文件和包清单一起交流。朋友包含真实历史，适合本次私下共同开发；后续公开仓库应从标准源码包重新开始。

原运行配置去凭据后另存 `config.original-sanitized.json`，可对照当前 config.json 的暂停默认值；研究后明确恢复 `cognitive.enabled`、调度与自己的渠道授权。配置原件在本机不变。
