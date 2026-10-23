# 分发与打包 · v1.8.2

## 两份交付

| 包 | 内容 | 用途 |
| --- | --- | --- |
| `deepseek-friend-v1.8.2-source.zip` | 源码、锁文件、初始 Prompt/Self、文档、测试及许可证 | 常规部署、公开代码审阅；不含当前运行状态或依赖二进制 |
| `deepseek-friend-v1.8.2-friend.zip` | 上述内容，加当前数据、聊天、上下文、记忆、Self 历史、小房间、媒体及已安装依赖/网关 | OTREE 授权的可信朋友私下研究与架构融合 |

朋友包不因隐私而整批清空日志、reasoning、私有笔记或上下文。清理只针对授权凭据与派生垃圾。保留历史不等于迁移账号认证，也不保证不同机器路径可直接续跑全部会话。

## 生成和校验

```powershell
npm run release
# 先退出项目启动器，确保 Bridge 与独立 DSH 均停止：
npm run package
python scripts/package-release.py --verify Release/v1.8.2/deepseek-friend-v1.8.2-friend.zip
Get-FileHash Release/v1.8.2/deepseek-friend-v1.8.2-friend.zip -Algorithm SHA256
```

`release` 创建版本化源码目录，已经存在时拒绝覆盖。`package` 从当前工程生成两个 ZIP，输出同名文件存在时也拒绝覆盖。单独重新生成一类可用 `--edition source` 或 `--edition friend`，前提是该目标尚不存在。不要删除旧发行目录来覆盖发布。

朋友快照持有与 Bridge 相同的 SQLite 实例锁，并检查 DSH 端口离线；自定义到项目外的数据目录拒绝打包。SQLite 使用 backup API，清理在副本进行；原库和上下文不写入。全部状态准备完后生成 `PACKAGING_STAGED` 标志，此后可重启服务，压缩只读副本。

ZIP 内含 `PACKAGE_MANIFEST.json`：文件路径、长度、SHA-256、版本、版本化格式标识、状态计数和原部署根目录。外部 `CHECKSUMS.sha256` 与 `PACKAGES.json` 标出整包校验和。校验工具逐个解压流核对，不只验证 ZIP 能打开。

## 明确排除的内容

- `.key`、`.pem`、证书/密钥容器、`.env`、已知 credential/connection 文件、`.ssh/.aws` 等敏感目录：按路径在打开前排除。不会读取 DSH 签名密钥。
- 微信/QQ/DSH 登录状态、QQ 原生账号数据和配置目录、原生账号数据库；DSH profile 及已解析的路径覆盖文件由支持的启动流程重新生成。
- `.git`、`.research`、npm/cache、测试缓存、编译缓存、锁与 WAL/SHM/临时文件、旧 Release 和 Archive；当前权威历史仍保留。依赖内测试/示例及其中的密钥夹具不分发。
- 原生上传缓存和加密上传密钥。SQLite 内的微信 context/cursor、认证头、Key、Token 字段与媒体签名查询参数从导出副本清除；清理后的 FTS 索引重建并 VACUUM，避免旧明文残留在空闲页。

DSH 多帧 Zstandard Session 逐帧解码，只清理凭据字段/文本，记录与 header 重新编码为 DSH 可读的分帧格式。普通日志和上下文保留；不将内容输出到打包日志。原始 v0.1.0 Self 文本按原字节保留，没有每天或打包时重写人格。

这是针对当前已知存储与常见凭据形状的清理，不是任意未知插件、私有压缩附件或任意字符串的形式化秘密识别器。新增凭据存储必须同步扩展排除与测试；不要把未知凭据塞进普通图片或任意二进制文件后假设工具会理解它。包中仍包含真实私人经历，是本次明确授权给可信朋友的开发材料。

## 朋友版与原运行状态的差别

聊天、记忆、Self、日记、目标、闹钟及任务记录保留。导出配置关闭微信/QQ 与认知后台，交互 paused=true，群启用清单为空；只改变导出副本。待处理任务记录没有被当垃圾删除，恢复调度前须核对，尤其是 unknown/review 与原账号收件人。

本机重生 DSH profile、登录和媒体上传缓存；使用自己的 API Key 重新授权。绝对路径与旧 Session 桶名保留供研究，不自动篡改。换机运行和跨实例融合步骤见 [融合指南](integration-guide.md)。

## 许可证

本项目 MIT 只覆盖本项目源码。朋友包保留依赖自带许可证，并附 NapCat 的 [完整有限再分发许可证](licenses/NapCat-LICENSE.txt) 及来源/版本通知；网关未改源，不把它重新许可为 MIT。常规源码包不含这些运行时二进制。

原运行配置去凭据后另存 `config.original-sanitized.json`，可对照当前 config.json 的暂停默认值；研究后明确恢复 `cognitive.enabled`、调度与自己的渠道授权。配置原件在本机不变。
