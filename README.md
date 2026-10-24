# DeepSeek:Friend

**v1.12.0 · 微信 / QQ ↔ DeepSeek Harness 桥接器与持续认知扩展。Windows 优先。**

DSH 是唯一 Agent Runtime。Bridge 负责通讯、会话路由、来源标注、持续记忆、受控 Self 演化和本机控制台；推理、工具执行、MCP 和原生上下文管理交给项目独立的 DSH。当前前台模型为 **DeepSeek-V41-Flash（4.1 Flash）**。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [架构说明](docs/architecture.md) | 进程、模块、数据流、存储与真实 Prompt 角色 |
| [设计理念](docs/design-philosophy.md) | 统一身份、记忆与证据、可选演化、自由表达与权限 |
| [架构融合指南](docs/integration-guide.md) | 共同开发的入口、复用顺序与迁移边界 |
| [分发与打包](docs/distribution.md) | 源码包、保留状态的朋友包、清理与校验 |
| [部署与故障](docs/operations.md) | 配置、错误、unknown/review 与恢复 |
| [版本兼容](docs/compatibility.md) | 真实源码分析与未验证事项 |
| [MNN 集成与回滚](docs/mnn-integration.md) | 统一记忆、压力小憩、安装门禁与故障恢复 |
| [MNN 验收记录](docs/mnn-validation-v120.md) | 真实三轮小憩、回归、检索负面结果与限制 |
| [认知架构](docs/cognitive-architecture.md) | 空闲提取、Dreaming、Self 与来源校验 |
| [QQ 群管理](docs/qq-groups-v18.md) | 按群启停、作者身份与群收件人 |
| [DSF 备份与回滚](docs/dsf-format.md) | 独立格式版本检查、整份恢复与迁移、三次延时确认 |

## 当前能力

- 微信官方 iLink 扫码、长轮询、文本/图片收发；不依赖 OpenClaw，不使用微信 Hook、iPad 协议或 UI 自动化。
- QQ 好友私聊、白名单群聊、图片与收藏表情、合并转发文字/图片；转发视频跳过。语音/文件未实现。
- 所有渠道共用 WebUI 选定的一个当前正式 Session、统一 Self、记忆、日记和目标；正式会话归档不删除，独立测试空间可清空。
- 代码标注真实发送者，昵称/备注/群名片不授予身份；QQ 号 `3626097226` 才是可信 OTREE，群回复发回原群。
- MNN 统一记忆网络、空闲 15 分钟语义提取、Asia/Shanghai 03:00 分段 LLM Dreaming / ACR；85% / 95% 原生 Token 压力保护在原 Session 安全小憩，无 Basic 回退。Self 版本保留，MNN 正式自主提交暂不开放。
- 一轮多次发送、回复后持续思考、本机 reasoning/私有笔记、自主小闹钟及主动联系授权对象。单次输出上限防止报错，不设累计步数/Token 截止。
- 本机 WebUI 分页管理二维码、服务、会话、群聊、思考深度、Prompt、通讯录、小房间与 DSF 归档。互联网不对 Agent 展示，操作者仅能测试受限域名过滤。

## 环境与首次部署

基础桥接需要 **Node.js 24+、npm、Python 3.10+ 标准库**。MNN 另外使用现有 tokenizers、Jinja2 和经摘要校验的官方词表，测试使用 pytest；缺少依赖时先由操作者决定安装范围，不自动安装新运行时。已验证 Windows / Node 24.19.0 / Python 3.10。DSH 固定 **0.2.0-rc.2**，QQ 可选 Windows NapCat **4.18.41**。

```powershell
npm ci --cache .research/npm-cache
npm run dsh:setup
Copy-Item config.example.json config.json
# QQ 可选：
npm run qq:setup
```

已有 config.json 时不要覆盖。依赖只安装在项目内，不安装系统运行时；独立 DSH 不使用工作的 `G:\DeepSeek_Harness` 或 3080。

自行准备 DeepSeek API Key，保存为根目录 `DEEPSEEK_FRIEND.key`，或用 `DEEPSEEK_FRIEND_KEY_FILE` 指定位置。**分发包不含 Key 或登录凭证。** 该文件只用于已有可信启动程序注入 DSH 子进程，不要放入签名私钥；没有文件时可使用独立 DSH 的受支持配置入口。

双击 `start-web.bat`，或执行 `python launcher.py`。浏览器自动打开本机控制台，点击「一键启动全部」，分别用手机微信/QQ 扫码确认。网页按上游真实状态判断登录，不额外实施手机端冷静期。

| 服务/数据 | 默认位置 |
| --- | --- |
| WebUI | `http://127.0.0.1:3090`，一次性票据交换后清理 URL |
| 独立 DSH | `http://127.0.0.1:3088`，拒绝工作端口 3080 |
| OneBot / QQ 管理 | 回环 `3001` / `6101`，凭证鉴权 |
| 数据 / 小房间 | `data/` / `data/cognitive/room/` |
| DSH 原生上下文 | `.runtime/home/sessions/` |

控制台校验 Cookie、Origin/Host 和 CSRF，不要转发到公网。Windows 授权经当前用户 DPAPI 保护，不能跨电脑继承。已有终端实例时先停止，再交给集成启动器；关闭网页不停止服务，「退出启动器」只结束它创建的进程。

## 日常控制

「QQ 与通讯录 → 群聊管理」按群启停，新群默认关闭；启用后接收全部新消息，无需 @，停用不删历史。「会话与测试」显式切换当前正式会话，测试不发真实消息。「运行控制」调整深度、单次长度、暂停/停止/唤醒。「Prompt 与小房间」查看替换后的 SYS、旧备份及实际装配。

终端保留 `npm run doctor`、`npm start`、`npm run dsh:start -- --open`。故障时先核对 unknown 或 review，不盲目重复提交。回滚使用 [DSF](docs/dsf-format.md)，不要直接替换运行中的数据库。

## 测试与打包

```powershell
npm test
npm run check
python -m unittest discover -s tests -p "test_*.py"
npm run release
npm run package
```

输出保存在 `Release/v1.8.2/`，不覆盖旧版。`release` 生成源码目录，`package` 生成标准源码 ZIP 和特殊朋友 ZIP。**朋友包需要先停止项目 Bridge 与独立 DSH**；快照完成后可重启，压缩只读取副本。两份包都有清单与 SHA-256。朋友包保留日志和上下文，移除授权与垃圾，默认暂停、关闭渠道，详见 [打包说明](docs/distribution.md)。

Mock、实际协议和手机端验收分开记录；最终测试结果见 CHANGELOG。微信、QQ 私聊及原转发文字已有真实验收，群聊、转发图片等状态见专项文档；Linux 未实机验收，附带的 QQ 二进制是 Windows 版本。

## 工程边界与许可证

不保证严格 Exactly Once：去重与固定 ID 减少重复，未知发送标 unknown，DSH 未确认提交保留 review。P0/P1 是同一 system prompt 的有序段落，P2 是 DSH user-role context，不是模型原生四级权限。共享记忆披露依赖模型判断，不是逐用户硬性保密；群内发言对全体成员可见。Self 无权提升工具权限。

持续身份是可追溯的工程能力，不宣称已证实主观意识。默认不授予 Shell、任意文件或管理员权限；不另建 Agent 框架。上游协议和账号状态可能变化，不保证永久无人值守稳定。

本项目 [MIT](LICENSE)，第三方通知见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。NapCat 使用独立的有限再分发许可证，朋友包附全文，不受本项目 MIT 覆盖。原长版教程保留在 [v1.8.0 历史 README](docs/README-history-v1.8.0.md)，历史验收状态以新版本为准。开发历史见 [CHANGELOG](CHANGELOG.md)。
