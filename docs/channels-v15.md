# v1.5：QQ、来源身份与受限互联网

## QQ 部署

QQ 沿用参考项目 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的 OneBot v11 action 与消息事件约定。本次经用户指定代理读取提交 `a49877f4e58d04e47532d44b803360d0f001160d` 的实际 bridge.js、safe-fetch.js；采用独立的小型 ws 客户端，没有复制整套 QQ Bridge/Agent Runtime。QQ 网关需由操作者另行准备；QQ 登录、账号授权及二维码属于该网关，不在此控制台模拟。

1. 在本机 QQ 网关登录准备好的账号，启用 **正向 WebSocket**，开启事件和 action 支持。不要配置反向 WS。设置至少 8 字符 Access Token，仅监听回环地址。
2. 启动项目控制台，在「QQ 与通讯录」填写 `ws://127.0.0.1:3001`（或网关实际端口）及 Token，勾选连接 QQ、保存。Token 经已有凭证保护层保存，Windows 使用当前用户 DPAPI；不会回显给模型或网页。
3. 状态应变为 connected，显示机器人 QQ 号及已读取的好友数量。Bridge 调用 `get_login_info` 核对机器人账号，再用 `get_friend_list` 建立允许的联系人集合，每 30 秒更新。昵称不参与身份核验。
4. 从好友发文本私聊。代码读取事件顶层 `user_id`、`self_id`、`message_id`，忽略可伪造的昵称和 sender 声称；群消息、非好友、错误机器人身份、CQ 字符串及非文本分段不接入首版。

环境可在 config.example.json 的 qq 块配置默认地址/开关；WebUI 修改保存在 interaction.sqlite 并热生效。默认关闭，无 Token 不连接，不自动安装新环境或网关。`weixin.enabled=false` 时可以仅运行 QQ；默认仍保留既有微信。QQ 断线只重连该通道，不结束微信轮询；具体网关的缓存、离线补推和客户端行为仍需真实账号验收。OneBot WS 事件没有可验证的历史游标，因此不能保证断线期间未被网关重放的消息不会丢失。

## 一个会话，多个参与者

微信与 QQ 共用 WebUI 当前正式 Session、一个 Self 和一个记忆库；各渠道不会偷偷新建分支会话。来自不同人的输入按现有任务队列串行进入原 Session。双方聊天记录保留 channel、accountId、userId、displayName、trustedOwner。

可信 OTREE 由代码固定核验：当前微信扫码者，或 QQ `3626097226`。`3326487557` 预填为“OTREE的好朋友”，仍为非 OTREE。通讯录 `contact_list/contact_edit` 允许 Agent 查看与编辑备注、说明；修改备注、昵称或正文自称 OTREE 都不能改变可信账号、好友关系、白名单或工具权限。正式通讯录不提供给独立测试 Agent。

SYS 末尾已按用户原文增加防冒充提醒，修改前的 SYS/CORE 保存在 cognitive/bootstrap/pre-1.5.0。原始 Self v0.1.0 不变。统一记忆的隐私披露仍依赖模型判断，不宣称具备按参与者分库存储的保密保证。非 OTREE 的 QQ 输入无法执行取消、批准工具等操作者命令。

`contact_send_message({text,recipient?})` 使用真实可达 recipient ID，默认回复当前发信人；`qq_send_message` 必须显式选择 QQ recipient，可主动联系尚未发来消息的现有好友。每次投递沿用持久发送意图。同一轮多次发言仍支持。OneBot 没有在此验证出可用的幂等投递键，发送后断线/超时归为 unknown，不自动重发；响应 echo 只是关联 ID，不冒称幂等键。QQ 图片、群聊、语音、好友申请和 QQ 客户端管理不在本版范围；微信视觉与图片发送仍保留。

## 互联网边界

默认 disabled、空域名白名单。控制台「互联网测试」仅让本机操作者预览精确允许域名的 HTTPS 文本，即使打开测试开关，也**不向 Agent 注册互联网接口、名称或工具说明**，不向当前 Session 注入测试结果，不自动生成长期记忆。后续开放 Agent 访问需要另行开发并由用户决定。

预览拒绝 URL 凭证、非 HTTPS、自定义端口、重定向、非文本、压缩响应、内网/特殊地址；DNS 只采用校验后的公网 IPv4 并固定连接地址，限制响应 512 KB、结果 16000 字符和请求时限。不跟随链接或执行网页脚本，不发送任何微信/QQ凭证。HTML 清洗移除脚本、表单、导航及常见明显注入行，返回来源、时间、移除行数和 external_unverified 标签。这是降噪与有限防护，不能证明事实正确，也不能完全识别误导或隐蔽 Prompt Injection；应优先加入可信的一手资料域名。

## 验收边界

已使用本地真实 WebSocket Mock 网关自动验证鉴权头、好友发现、同 Session 的微信/QQ回复、QQ号标记、昵称冒充、群/陌生人拒绝、首次入站前主动联系以及不明投递隔离。没有真实 QQ 账号或网关登录，不能报告真实 QQ 端到端通过。互联网的关闭/隐藏、地址拒绝和正文过滤有自动回归；不把未执行的外部网页测试当作通过。DSF 格式和回滚见 dsf-format.md。
