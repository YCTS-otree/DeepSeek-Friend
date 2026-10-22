# Python 本地 Web 启动器

版本 1.1.1；Python 3.10+，标准库 HTTP 服务，不增加 Python 依赖或虚拟环境。

## 使用

1. 关闭先前从终端运行的项目 Bridge/独立 DSH。
2. 双击 `start-web.bat`。保持启动器终端运行，浏览器会自动打开。
3. 点击「启动服务」；等待独立 DSH ready，再扫码。手机确认或验证码均按页面提示操作。
4. 「重新扫码 / 刷新」先优雅停止当前 Bridge，执行独立登录；成功后自动恢复 Bridge。旧凭证在新登录成功前保留，消息数据库和 Session 映射不删除。
5. 「停止」依次停止本启动器创建的 Bridge、DSH；「退出启动器」还关闭本地 HTTP 服务。仅关闭标签页会继续运行。

如需其他端口：`python launcher.py --port 3091`。不打印带登录票据的 URL；`--no-browser` 仅用于受控开发场景，手动访问裸地址不会获得管理权限。默认浏览器未打开时，停止后重新运行启动器并检查系统默认浏览器设置。一个浏览器登录票据只可交换一次；重新启动后旧 Cookie 自动失效。

## 结构与边界

- `launcher.py` 负责本地 HTTP、CSRF/会话校验、进程状态及子进程控制；`web/` 是无构建步骤的 HTML/CSS/JS。
- `src/launcher-io.js` 是 Node 专用逐行 JSON 控制通道，仅在 `BRIDGE_LAUNCHER=1` 时启用。允许 shutdown、open-dsh、绑定请求 ID 的数字验证码；不接受任意命令、文件路径或 Shell。
- QR 使用现有 qrcode-terminal 的 MIT 编码器生成模块，用确定性 SVG 绘制。payload 不参与 HTML 字符串拼接；Python 只接收严格匹配的黑白 SVG，浏览器通过同源图片端点获取。QR 状态不会含 payload、SVG 或 Token。
- `src/auth.js` 保留原协议状态机，增加展示状态回调；CLI 授权流程继续可用。
- 独立 DSH 启动 URL 仅保存在 Node 包装器内存中，「打开 DSH」直接传给本机浏览器，不经 Python API 或日志；不读取签名私钥。
- HTTP 仅允许精确 `127.0.0.1:<port>` Host；控制请求需要同源 Origin、HttpOnly/SameSite=Strict Cookie 和 CSRF。页面、二维码和状态均 no-store，禁止 iframe、外部脚本和任意文件访问。
- Python 不加载 API Key 文件。原 Node DSH 包装器按既有规则将已确认为 API Key 的文件传给官方 DSH 进程。

## 故障与恢复

服务端口占用时拒绝接管；请由操作者停止原实例。Python 只保存自己创建的 Popen 对象，先经 stdin 请求关闭；超时后只结束该仍存活 PID 的进程树。DSH 包装器会在 stdin EOF 时停止它创建的 DSH；Bridge 的同一通道触发 AbortController。独立 DSH 意外退出后向 Bridge 发送停止请求，页面保留脱敏错误。突然断电等故障仍由原 SQLite 恢复逻辑处理，不承诺严格 Exactly Once。

登录过期会清除内存二维码及验证码请求；刷新时旧验证码 ID 无效。验证码只可提交一次，不写日志。授权失败不会开放工具权限；Bridge 与 DSH Preset 的权限边界完全沿用原实现。网页登录会话是本地控制面的保护，不作为同一操作系统内恶意程序之间的隔离机制。

## 验证

```powershell
npm run check
npm test
python -m unittest discover -s tests -p "test_*.py" -v
```

Python 测试覆盖状态切换、恶意 SVG 拒绝、旧验证码拒绝、日志白名单、外部进程保护、实际假子进程停止、DSH 退出、HTTP 认证/票据/CSRF/Origin/Host、请求大小、文件白名单与二维码清除。可选 OpenCV 解码测试在本机已有 cv2/numpy 时运行，未安装则明确跳过；不为此自动安装依赖。真实微信端到端仍需要用户用手机完成扫码和发送消息。
