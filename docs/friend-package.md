# 给可信朋友的完整开发交流包

这是 OTREE 明确授权保留日志与上下文的 DeepSeek:Friend v1.8.2 快照，供你们私下共同开发、比较实际行为与融合架构。源码结构、已安装依赖、聊天、DSH 原生上下文、思考记录、统一记忆、Self 历史、媒体和小房间尽量原样保留。

**Key、签名密钥、Cookie、微信/QQ 登录材料及数据库内可复用凭据已按已知规则排除或清理。** 缓存、旧打包/归档、研究副本、Git 元数据和锁文件不随包复制。不是一个能继续代表 OTREE 账号登录的克隆，也不是一只新的空白小鲸鱼。

默认暂停、关闭渠道和认知后台，群白名单为空。先看 README、docs/architecture.md、docs/design-philosophy.md 和 docs/integration-guide.md，再决定如何恢复调度。请使用自己的 Key 和账号。当前 SYS、Self、可信身份常量仍是原项目的实际内容。

注意原绝对路径和 Session 目录名可能保留；本包未提供跨机器路径自动重定位或一键融合器。不要覆盖自己正在使用的 DSH home，也不要直接拼接两份数据库/压缩日志。保留原始副本后在独立目录研究。

`PACKAGE_STATE.json`、`PACKAGE_MANIFEST.json` 包含状态计数和文件校验，普通日志/上下文没有因隐私而整批丢弃。清理规则与能力边界见 docs/distribution.md。第三方二进制仍受自身许可约束，NapCat 许可证全文和来源随包保留。

原运行配置去凭据后另存 `config.original-sanitized.json`，可对照当前 config.json 的暂停默认值；研究后明确恢复 `cognitive.enabled`、调度与自己的渠道授权。配置原件在本机不变。
