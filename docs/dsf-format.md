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

默认输出 `Archive/YYYYMMDD-HHMMSS-随机标识.DSF`，不覆盖已有文件。v1.9.0 控制台「DSF 归档」支持创建、下载、完整校验、备注、移入回收站及还原备份；不提供永久删除。网页创建/回滚会停止本启动器持有的 Bridge 和独立 DSH，完成或失败后恢复原来运行的服务；不接管外部服务。保存/恢复全过程持有与 Bridge 相同的 instance-lock.sqlite 排他锁，拒绝正在监听的独立 DSH。命令行操作前仍需停机；外部绕过锁启动服务不在格式保证范围。当前仅允许项目内部数据目录，不对外部路径执行恢复。

## 三次独立确认

网页点击某份备份的「回滚」后，依次展示目标核对、覆盖范围、保存当前状态三个确认阶段。每次提示出现后按钮至少禁用 3 秒，服务端也以单调时间检查每一阶段；即使修改前端或直接发请求也无法提前完成。各阶段使用一次性 nonce、固定目标摘要和 15 分钟有效期，过期、取消、重复确认或目标文件变化会停止操作。第三次确认后才开始停机、保存当前状态并完整校验，再恢复选定备份。当前备份失败或校验失败均不替换数据。

CLI 的 `--confirm-restore` 也要求交互终端中的三次确认，每次强制等待 3 秒；参数不再等同于跳过确认，不接受管道自动输入。内部恢复函数供通过网页三次校验的管理器调用。版本不匹配的备份可查看和下载，但网页不允许强行回滚；请先使用其对应的 Release 程序。

## 大功能开放前的检查点

本机控制台扩大互联网白名单/开启互联网测试、启用新 QQ 通道或新群时，经 Python `ArchiveManager.feature` 集中入口先创建并完整校验 DSF，归档完成后才应用设置。关停和相同设置重复保存不强制再备份。处理会短暂停止通讯，QQ 不保证重投维护期间未被 Bridge 接收的消息。归档增加 reason 字段，不改变 DSF v1 结构兼容性；旧归档显示 legacy。

项目 AGENTS.md 要求所有后续重大信息来源和能力开放接入这一检查点；不能把新增开关绕过该入口。当前互联网仍仅供本机操作者测试，不向 Agent 注册访问工具，创建备份本身不是开放互联网的授权。

回滚前先校验格式、兼容版本、清单、SHA-256、路径、重复文件、符号链接与大小限制，且自动生成一份恢复前状态 `.DSF`。仅替换白名单组件；顶层数据库旧 WAL/SHM 一并隔离，原生派生投影缓存清除后由 DSH 从恢复的日志重建，凭证原地保留。应用阶段异常会将已移动组件还原；断电等无法执行异常回滚的情况应使用恢复前归档重试。此为多组件受控恢复，不声称文件系统跨目录事务。

归档只含状态，恢复要求与创建时**相同应用版本与 DSH 0.2.0-rc.2**；例如旧归档需先切回 Release 对应程序，再恢复，不执行未经验证的数据库跨版本降级。跨机器迁移仍需重新登录与配置 Key；原生上下文中的绝对路径及外部工具环境未保证可迁移。校验和用于损坏检测，不能证明归档来自可信作者，不要恢复陌生来源归档。

测试覆盖合成聊天/原生上下文/房间的归档与回滚、恢复前备份、凭证路径排除、篡改拒绝、目录穿越拒绝、版本不匹配与运行中锁拒绝。新增逐阶段不足 3 秒拒绝、nonce 重放、取消、目标变更、备份失败不恢复/不开放功能、HTTP Cookie/Origin/CSRF、下载鉴权、回收站还原及真实启动器工作队列互斥。浏览器使用独立测试目录完成三次确认和实际回滚，并核验恢复前 DSF 存在。正式数据只做创建和完整校验，不执行回滚测试。
