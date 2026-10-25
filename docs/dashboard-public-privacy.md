# 仪表板、公网访问与维护记录隔离（1.13.0）

首页是动态仪表板；登录、二维码、一键启动和渠道连接放在「连接与扫码」，会话、思考、Prompt、小房间、归档继续保留独立页面。

## 数字来自哪里

- 上下文、累计 Token、固定指令与工具开销：DSH `session/projections` 的数值白名单。每 5 秒刷新缓存，不读取或返回 Prompt、推理正文和凭证。
- Guardian 压力优先显示最近一次保护预测，包含下一轮及输出预留，明确标注时间；原生投影另用于累计用量。两种测量口径不同。
- 今日用量：本机上海时区当天已记录的 Provider usage。缓存读取、写入和非缓存输入分别统计，reasoning 是输出的一部分，不额外加一次。
- MNN 后台累计用量：成功的 Provider 收据，按 response ID 去重；移到维护审计目录的旧收据以纯数字台账继续计数。不同卡片的范围不同，不直接相加作为账单。
- 余额：[DeepSeek 官方 `/user/balance`](https://api-docs.deepseek.com/api/get-user-balance/)，一分钟缓存，展示返回的币种及余额。查询失败显示不可用，不伪造 0 元；账户中其他客户端的消耗也会反映到余额。
- 运行状态、消息队列、投递状态、记忆节点、闹钟来自本项目数据库。暂停明确显示，不会误报为等待消息。

## 公网启动

根目录 `ADMIN_PWD.key` 保存操作者设置的登录密码，UTF-8，一行，8～256 字符。它是控制台密码文件，不能放签名私钥，不纳入 Git、DSF 或发布包。修改后旧登录立即失效；不要把密码写入 URL。

```powershell
python launcher.py --port 3101 --public --start
```

公网模式先由 `ArchiveManager.feature('admin-public-configure')` 停服、创建完整 DSF 并校验，成功后才能绑定 `0.0.0.0:3101` 和 `[::]:3101`，共享密码验证。任一监听或备份失败都不开放。设置保存在 `data/admin-access.json`，后续普通启动沿用；`--local` 本次强制回环监听。默认新安装仍是本机模式。

使用 `http://IPv4地址:3101/` 或 `http://[IPv6地址]:3101/`。当前 Host 校验接受数字 IP 和 localhost，必须带端口；尚未配置自定义域名或反向代理来源。两个地址族都要求登录，包括本机访问；二维码、Prompt、思考、API、归档下载全部受保护。随机登录会话有效 12 小时，HttpOnly/SameSite Cookie、独立 CSRF、Origin/Host 校验及失败限速保留。退出登录可立即注销当前会话。

Windows 防火墙需管理员权限。在管理员 PowerShell 中执行：

```powershell
.\scripts\open-web-firewall.ps1 -Port 3101 -PythonPath 'G:\Python\Python_Environment\Python310\python.exe'
```

脚本只放行指定 Python 程序的 TCP 端口，不关闭防火墙。IPv4 NAT 还需路由器端口转发；IPv6 需可路由地址及上游入站许可。绑定双栈不等于已经从公网验收可达。本次执行账户没有 Windows 管理员令牌，规则创建被拒绝，未绕过系统权限。

当前是 HTTP；公网密码和正文没有传输加密。需要加密时应另行部署 HTTPS，并适配受信任来源和 Cookie Secure 策略；当前没有宣称已完成 TLS。公网控制台开放不等于开放 Agent 互联网工具，后者仍关闭。

## 隔离维护诊断

维护诊断属于操作者审计，不作为小鲸鱼的经历。MNN 导入与提取会将内部错误、请求头、turn/end 等诊断标记为 operator-only；相关来源有持久化 tombstone，重新扫描不可复活。清理会传播至依赖记忆、FTS/向量、关联和历史索引。日记相关段落改为有记录依据的交谈间隔，不虚构修复原因；普通技术聊天可能被关键词策略误隐藏，需操作者核对。

本机聊天记录接口对匹配的整条记录显示隐藏标记，底层审计数据保留。旧 Dreaming 详细收据移至 `Archive/operator-audit/`，不再进入 Agent 记忆检索。当前 Preset 不授予通用文件/Shell 访问，这些目录不是 Agent 工具入口。

活动上下文修整使用原生 Cognitive Compaction 的检查点，逐段替换历史非系统 Surface；处理历史多份系统段落时逐个保护系统和工具配对。**原 Session ID、原始事件前缀、全部 SYS 和 Self Model 不变。** 不使用 Basic Compaction，不提交新聊天，不向用户发测试消息。中途失败的 `privateRepairPending` 会阻止 Bridge 启动，须完成维护后再恢复。

显式维护命令（会停服并先备份，不应重复执行已成功的维护）：

```powershell
python scripts/privacy_maintenance.py --session <原Session UUID> --apply
```

这不是密码学擦除。旧 DSF、原生原始事件和操作者审计仍保留原文，回滚可能带回被隐藏内容；第三方收到的聊天也不会被撤回。没有保证模型不能根据其他线索推测。

**1.13.1 更正：**本版最初的隐私重建虽保住原始事件和 Self，却丢失了过多有效对话，导致表达连续性下降。现已增加有来源的近期完整对话，详见[事故记录与新增验收标准](incident-conversation-continuity.md)。原文“成功”仅代表当时列出的数据与安全检查，不能据此认定对话连续性已经验证。

对于已整理得很短的上下文，Dreaming 仍会持久化记忆；若没有安全区间或检查点反而变大，只有独立原生测量确认压力低于恢复水位才允许不改 Surface。高压力、未知媒体计价、证据错误仍拒绝；不会静默调用 Basic，也不会因此重复唤醒 Agent。

## 本次验证

- Node：193 项，190 通过、3 项外部真实环境测试跳过；Python：67 通过；MNN Python：70 通过；原生后端 Node：9 通过；JS 静态检查通过。
- 最初沙箱运行的 Windows 子进程取消测试失败；正常执行权限下完整重跑通过，保留两份日志，没有把首次失败计为通过。
- 正式修整：4,388 条原始事件完整保留，追加至 4,569；原生重开、SYS、Self 摘要校验通过。278 个诊断来源及其依赖被屏蔽，最终诊断节点为 0。相关查询可能返回其他正常关联结果，已验证这些结果不含诊断内容。
- 修整后 Provider 校准压力约 29.21% → 18.76%，不是删除原始历史。
- 实际 IPv4/IPv6 回环登录、未授权保护、CSRF、退出登录均通过；DSH/微信/QQ 已恢复，原 Session 保持。实际余额查询成功返回 USD/CNY。启动补执行已实际完成安全 no-op，Guardian 恢复 NORMAL，重查诊断节点仍为 0。
- 未执行公网外部网络探测、Linux 实机或浏览器目视验收。原生浏览器控制被执行器阻止，布局采用响应式 Grid 并通过 DOM/路由回归；不能据此声称所有尺寸都已人工确认。

详细运行记录位于本机 `.research/public-live-acceptance.json`、`.research/privacy-acceptance.json`、`.research/privacy-recall-check.json` 和各 `dashboard-final-*` 日志。公开文档不包含私人聊天、余额数值或 Cookie。
