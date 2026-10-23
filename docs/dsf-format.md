# DSF v1：DeepSeek:Friend State

`.DSF` 使用 ZIP 容器，内部唯一 manifest.json 声明 `format=DeepSeek:Friend State`、`schemaVersion=1`、createdAt、appVersion、dshVersion、`credentialsIncluded=false` 及每个文件的相对路径、字节数、SHA-256。

归档范围使用代码白名单：应用 bridge.sqlite、interaction.sqlite、cognitive、testing、media；项目独立 DSH 的 sessions、attachments、llm-deepseek/files-v3.json；当前 SYS_Prompt.txt 和 cognitive/CORE.md。SQLite 通过原生 backup API 保存一致数据库，原生 Session 日志保留压缩文件原样，不自行重构另一套 Agent 上下文。包括双方历史、原生上下文、统一记忆/Self版本、小房间、通讯录和运行设置；不包含程序、依赖、签名私钥、API Key、微信/QQ/DSH登录凭证或整个 DSH home。原始 Self v0.1.0 的源码历史永远保留，不因恢复覆盖。

归档有私密对话和模型本机思考，**不是加密格式**。默认保存在项目 Archive，Windows 使用已有安全目录 ACL，Linux 目录仅用户访问；请妥善保管，不上传公开仓库。

## 创建与回滚

先在 WebUI 停止服务，确认独立 DSH 3088 和 Bridge 都已停止，再在项目目录运行（Python 3.10+，无需新依赖）：

```powershell
python scripts/dsf.py create
python scripts/dsf.py inspect "Archive/实际文件名.DSF"
python scripts/dsf.py restore "Archive/实际文件名.DSF" --confirm-restore
```

默认输出 `Archive/YYYYMMDD-HHMMSS-随机标识.DSF`，不覆盖已有文件。控制台「DSF 归档」显示现存列表和命令。保存/恢复全过程持有与 Bridge 相同的 instance-lock.sqlite 排他锁，拒绝正在监听的独立 DSH。操作者应停止全部 DSH 后台进程再执行；外部绕过锁启动服务不在格式保证范围。当前仅允许项目内部数据目录，不对外部路径执行恢复。

回滚前先校验格式、兼容版本、清单、SHA-256、路径、重复文件、符号链接与大小限制，且自动生成一份恢复前状态 `.DSF`。仅替换白名单组件；顶层数据库旧 WAL/SHM 一并隔离，原生派生投影缓存清除后由 DSH 从恢复的日志重建，凭证原地保留。应用阶段异常会将已移动组件还原；断电等无法执行异常回滚的情况应使用恢复前归档重试。此为多组件受控恢复，不声称文件系统跨目录事务。

归档只含状态，恢复要求与创建时**相同应用版本与 DSH 0.2.0-rc.2**；例如旧归档需先切回 Release 对应程序，再恢复，不执行未经验证的数据库跨版本降级。跨机器迁移仍需重新登录与配置 Key；原生上下文中的绝对路径及外部工具环境未保证可迁移。校验和用于损坏检测，不能证明归档来自可信作者，不要恢复陌生来源归档。

测试覆盖合成聊天/原生上下文/房间的归档与回滚、恢复前备份、凭证路径排除、篡改拒绝、目录穿越拒绝、版本不匹配与运行中锁拒绝。当前真实归档仅执行创建和完整校验，不在正式数据上做破坏性回滚测试。
