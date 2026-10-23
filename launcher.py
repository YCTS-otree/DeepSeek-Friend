"""DeepSeek:Friend local launcher. Python 3.10+, standard library only."""
from __future__ import annotations

import argparse
import collections
import hmac
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import signal
import socket
import subprocess
import threading
import time
import uuid
from urllib.parse import parse_qs, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
EVENT_RE = re.compile(r"^(?:bridge|dsh|weixin|inbox|outbox|session|approval|launcher)\.[a-z0-9.-]{1,80}$")
CODE_RE = re.compile(r"^[a-z0-9_.-]{1,80}$", re.I)
LOGIN_STATES = {"refreshing", "waiting", "scanned", "verify", "confirming"}


def same(a, b):
    return isinstance(a, str) and isinstance(b, str) and hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


class LauncherError(Exception):
    pass


class Controller:
    def __init__(self, root=ROOT, auto_qq=False):
        self.root = Path(root)
        self.auto_qq = auto_qq
        self.lock = threading.RLock()
        self.children = {}
        self.cancel = threading.Event()
        self.closed = False
        self.commands = queue.Queue()
        self.logs = collections.deque(maxlen=80)
        self.session_requests = {}
        self.session_commands_lock = threading.Lock()
        self.state = {"version": VERSION, "dsh": "stopped", "bridge": "stopped",
                      "login": "idle", "verifyId": None, "qrRevision": 0,
                      "busy": False, "error": None, "baseUrl": "http://127.0.0.1:3088"}
        self.svg = None
        self.qq_svg = None
        self.state.update(qqGateway="stopped", qqLogin="idle", qqQrRevision=0, qqHasQr=False, qqAccount=None, qqError=None, qqErrorDetail="")
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()

    def snapshot(self):
        with self.lock:
            return {**self.state, "hasQr": self.svg is not None, "logs": list(self.logs)}

    def _log(self, event, code=None):
        if not EVENT_RE.fullmatch(event):
            return
        entry = {"time": time.strftime("%H:%M:%S"), "event": event}
        if isinstance(code, str) and CODE_RE.fullmatch(code):
            entry["code"] = code
        with self.lock:
            self.logs.append(entry)

    def _clear_login(self):
        self.svg = None
        self.state.update(login="idle", verifyId=None)
        self.state["qrRevision"] += 1

    def enqueue(self, action):
        if not isinstance(action, str) or action not in {"start", "stop", "login", "open-dsh", "qq-start", "qq-stop", "qq-refresh"}:
            raise LauncherError("invalid-action")
        with self.lock:
            if self.closed:
                raise LauncherError("launcher-closed")
            if action == "stop":
                self.cancel.set()
            elif self.state["busy"]:
                raise LauncherError("launcher-busy")
            elif action in {"start", "login"}:
                self.cancel.clear()
            self.state["busy"] = True
            self.commands.put(action)

    def _work(self):
        while True:
            action = self.commands.get()
            if action is None:
                return
            try:
                if action == "qq-start":
                    self._start_qq()
                elif action == "qq-stop":
                    (self.root / ".runtime/qq-gateway/autostart.flag").unlink(missing_ok=True)
                    self._stop_child("qq")
                elif action == "qq-refresh":
                    if not self._send("qq", {"command": "qq-refresh"}):
                        self._start_qq()
                elif action == "stop":
                    self._stop_all()
                elif action == "open-dsh":
                    if not self._send("dsh", {"command": "open-dsh"}):
                        raise LauncherError("dsh-not-ready")
                else:
                    self._start(action == "login")
            except Exception as exc:
                code = str(exc) if isinstance(exc, LauncherError) else "launcher-operation-failed"
                with self.lock:
                    self.state["error"] = code
                self._log("launcher.failed", code)
            finally:
                with self.lock:
                    self.state["busy"] = not self.commands.empty()

    def _alive(self, name):
        with self.lock:
            child = self.children.get(name)
            return child is not None and child.poll() is None

    def _spawn(self, name, args, mode="start"):
        node = shutil.which("node")
        if not node:
            raise LauncherError("node-not-found")
        env = {**os.environ, "BRIDGE_LAUNCHER": "1"}
        child = subprocess.Popen([node, *args], cwd=self.root, env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 text=True, encoding="utf-8", errors="replace", bufsize=1,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        with self.lock:
            self.children[name] = child
            self.state[name] = "starting"
        threading.Thread(target=self._read, args=(name, child, mode), daemon=True).start()
        return child

    def _read(self, name, child, mode):
        try:
            for line in child.stdout:
                if len(line) > 2_000_000:
                    continue
                try:
                    data = json.loads(line)
                    if isinstance(data, dict):
                        with self.lock:
                            if self.children.get(name) is child:
                                if not getattr(child, "launcher_stopping", False):
                                    self._event(name, data)
                except (ValueError, TypeError):
                    continue
        finally:
            child.stdout.close()
            code = child.wait()
            with self.lock:
                if child.stdin:
                    child.stdin.close()
                if self.children.get(name) is not child:
                    return
                if self.state[name] != "error":
                    self.state[name] = "stopped" if code == 0 or self.cancel.is_set() else "error"
                if name == "qq":
                    self.qq_svg = None
                    self.state.update(qqGateway="stopped" if code == 0 else "error", qqLogin="idle", qqHasQr=False)
                if name == "bridge":
                    self.svg = None
                    self.state["verifyId"] = None
                    if self.state["login"] != "ready":
                        self.state["login"] = "idle"
                if name == "dsh" and not self.cancel.is_set():
                    self.state["error"] = "dsh-exited"
                    self._send("bridge", {"command": "shutdown"})
                if (name == "bridge" and mode == "login" and code == 0 and not getattr(child, "launcher_stopping", False)
                        and not self.cancel.is_set() and not self.closed):
                    self.state["busy"] = True
                    self.commands.put("start")
            self._log("launcher." + name + "-exited")

    def _event(self, name, data):
        event = data.get("event", "")
        if name == "qq" and event == "ui.qq":
            phase = data.get("phase")
            if phase not in {"starting", "waiting_qrcode", "generating_qrcode", "qrcode_scanned", "account_in_use", "initializing", "ready", "offline", "reconnecting", "error"}:
                return
            svg = data.get("svg")
            if svg is not None and (not isinstance(svg, str) or len(svg) > 500000 or not svg.startswith('<svg xmlns="http://www.w3.org/2000/svg"') or re.search(r"<(?:script|image|foreignObject)\b|(?:href|onload)=", svg, re.I)):
                return
            if self.qq_svg != svg:
                self.qq_svg = svg
                self.state["qqQrRevision"] += 1
            detail = data.get("errorDetail", "")
            self.state.update(qqGateway="ready", qqLogin=phase, qqHasQr=svg is not None, qqAccount=data.get("account") if str(data.get("account", "")).isdigit() else None, qqError=data.get("error") if CODE_RE.fullmatch(str(data.get("error", ""))) else None, qqErrorDetail=detail[:2000] if isinstance(detail, str) else "")
            return
        if name == "bridge" and event == "ui.sessions":
            pending = self.session_requests.get(data.get("id"))
            if pending:
                try:
                    pending.put_nowait(data)
                except queue.Full:
                    pass
            return
        if name == "bridge" and event == "ui.qr":
            svg = data.get("svg", "")
            # Only our deterministic black/white SVG encoder may supply this IPC field.
            if (isinstance(svg, str) and len(svg) < 2_000_000
                    and re.fullmatch(r'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \d+ \d+" width="\d+" height="\d+" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h\d+v\d+H0z"/><path fill="#000" d="[M0-9 hvlz-]+"/></svg>', svg)):
                self.svg = svg
                self.state.update(login="waiting", verifyId=None)
                self.state["qrRevision"] += 1
            return
        if name == "bridge" and event == "ui.login" and data.get("state") in LOGIN_STATES:
            self.state["login"] = data["state"]
            if data["state"] == "refreshing":
                self.svg = None
                self.state["verifyId"] = None
            return
        if name == "bridge" and event == "ui.verify":
            if isinstance(data.get("id"), str) and re.fullmatch(r"[a-f0-9-]{36}", data["id"]):
                self.state.update(login="verify", verifyId=data["id"])
                self.svg = None
            return
        if event == "dsh.independent-ready":
            self.state["dsh"] = "ready"
        elif event == "bridge.started":
            self.state["bridge"] = "ready"
            self.svg = None
            self.state.update(login="ready", verifyId=None)
        elif event == "weixin.login-success":
            self.svg = None
            self.state.update(login="ready", verifyId=None)
        elif event in {"bridge.failed", "dsh.failed", "dsh.connection-failed"}:
            code = data.get("code")
            self.state["error"] = code if isinstance(code, str) and CODE_RE.fullmatch(code) else "service-failed"
            self.state[name] = "error"
            if name == "bridge":
                self._clear_login()
        self._log(event, data.get("code"))

    def _start(self, relogin=False):
        with self.lock:
            self.state["error"] = None
        if not self._alive("dsh"):
            node = shutil.which("node")
            if not node:
                raise LauncherError("node-not-found")
            result = subprocess.run([node, "scripts/launcher-config.js"], cwd=self.root,
                                    capture_output=True, text=True, timeout=20,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if result.returncode:
                raise LauncherError("config-invalid")
            base = json.loads(result.stdout)["baseUrl"]
            with self.lock:
                self.state["baseUrl"] = base
            url = urlsplit(base)
            with socket.socket() as probe:
                probe.settimeout(0.5)
                if probe.connect_ex((url.hostname, url.port)) == 0:
                    raise LauncherError("dsh-port-in-use")
            self._spawn("dsh", ["scripts/dsh.js", "start"])
        deadline = time.monotonic() + 75
        while self.snapshot()["dsh"] != "ready":
            if self.cancel.wait(0.1):
                return
            if not self._alive("dsh") or self.snapshot()["dsh"] == "error":
                raise LauncherError(self.snapshot()["error"] or "dsh-start-failed")
            if time.monotonic() > deadline:
                self._stop_child("dsh")
                raise LauncherError("dsh-start-timeout")
        if self.cancel.is_set():
            return
        if relogin:
            self._stop_child("bridge")
        if not self._alive("bridge"):
            with self.lock:
                self._clear_login()
            self._spawn("bridge", ["src/main.js", "login" if relogin else "start"], "login" if relogin else "start")

        if self.auto_qq and (self.root / ".runtime/qq-gateway/4.18.41/node.exe").exists():
            self._start_qq()

    def _send(self, name, data):
        with self.lock:
            child = self.children.get(name)
            if child is None or child.poll() is not None:
                return False
            try:
                child.stdin.write(json.dumps(data) + "\n")
                child.stdin.flush()
                return True
            except (BrokenPipeError, OSError, ValueError):
                return False

    def verify(self, request_id, code):
        with self.lock:
            if (not isinstance(code, str) or not re.fullmatch(r"[0-9]{1,12}", code)
                    or not request_id or request_id != self.state["verifyId"]):
                raise LauncherError("verification-invalid-or-stale")
            if not self._send("bridge", {"command": "verify", "id": request_id, "code": code}):
                raise LauncherError("bridge-not-running")
            self.state.update(verifyId=None, login="confirming")

    def sessions(self, action, args=None):
        with self.session_commands_lock:
            return self._sessions(action, args)

    def _sessions(self, action, args=None):
        if not isinstance(action, str) or action not in {"list", "history", "create", "switch", "archive", "room-info", "runtime-status", "runtime-configure", "runtime-stop", "runtime-wake", "thoughts", "prompts", "alarms", "alarm-create", "alarm-cancel", "test-send", "test-clear", "contacts-list", "contacts-edit", "channels-status", "qq-configure", "internet-configure", "internet-preview", "archive-list"} or (args is not None and not isinstance(args, dict)):
            raise LauncherError("session-action-invalid")
        request_id = str(uuid.uuid4())
        pending = queue.Queue(maxsize=1)
        with self.lock:
            if self.closed or self.state["busy"]:
                raise LauncherError("launcher-busy")
            alive = self._alive("bridge")
            if alive:
                self.session_requests[request_id] = pending
        if alive:
            try:
                if not self._send("bridge", {"command": "sessions", "id": request_id, "action": action, "args": args or {}}):
                    raise LauncherError("bridge-not-ready")
                try:
                    data = pending.get(timeout=8)
                except queue.Empty:
                    raise LauncherError("session-result-unknown")
            finally:
                with self.lock:
                    self.session_requests.pop(request_id, None)
        else:
            node = shutil.which("node")
            if not node:
                raise LauncherError("node-not-found")
            try:
                result = subprocess.run([node, "scripts/sessions.js"], cwd=self.root,
                                        input=json.dumps({"action": action, "args": args or {}}),
                                        capture_output=True, text=True, encoding="utf-8", timeout=12,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                data = json.loads(result.stdout)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                raise LauncherError("session-result-unknown")
        if data.get("error"):
            code = data["error"]
            raise LauncherError(code if isinstance(code, str) and CODE_RE.fullmatch(code) else "session-operation-failed")
        return data.get("result", {})

    def _stop_child(self, name):
        with self.lock:
            child = self.children.get(name)
        if child is not None:
            child.launcher_stopping = True
            self._send(name, {"command": "shutdown"})
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                # Only the still-live Popen we created; never discover/kill services by port or name.
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
                else:
                    child.kill()
                child.wait(timeout=10)
            if child.stdin:
                child.stdin.close()
            with self.lock:
                if self.children.get(name) is child:
                    self.children.pop(name, None)
        with self.lock:
            self.state[name] = "stopped"
            if name == "qq":
                self.qq_svg = None
                self.state.update(qqGateway="stopped", qqLogin="idle", qqHasQr=False, qqAccount=None, qqErrorDetail="")
            if name == "bridge":
                self._clear_login()

    def _start_qq(self):
        install = self.root / ".runtime/qq-gateway/4.18.41"
        if not (install / "node.exe").exists():
            raise LauncherError("qq-gateway-not-installed")
        if self._alive("qq"):
            return
        (install.parent / "autostart.flag").touch()
        self.state.update(qqGateway="starting", qqLogin="starting", qqError=None, qqErrorDetail="")
        self._spawn("qq", ["scripts/qq-gateway.js", "start"])

    def _stop_all(self):
        self.cancel.set()
        self._stop_child("qq")
        self._stop_child("bridge")
        self._stop_child("dsh")
        with self.lock:
            self.state["error"] = None

    def close(self):
        with self.lock:
            self.closed = True
            self.cancel.set()
            # Cancel queued starts so shutdown cannot revive an owned process.
            while True:
                try:
                    self.commands.get_nowait()
                except queue.Empty:
                    break
            self.commands.put("stop")
            self.commands.put(None)
        self.worker.join(timeout=40)


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, controller):
        if address[0] != "127.0.0.1":
            raise ValueError("loopback-only")
        self.controller = controller
        self.ticket = secrets.token_urlsafe(32)
        self.session = secrets.token_urlsafe(32)
        self.csrf = secrets.token_urlsafe(32)
        super().__init__(address, Handler)
        self.origin = "http://127.0.0.1:" + str(self.server_port)

    def launch_url(self):
        return self.origin + "/?ticket=" + self.ticket


class Handler(BaseHTTPRequestHandler):
    server_version = "DeepSeekFriend"

    def log_message(self, *_):
        pass  # HTTP URLs can contain the one-time browser ticket. Never log requests.

    def _reply(self, code, body=b"", content_type="application/json; charset=utf-8", headers=None):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        for name, value in {"Content-Type": content_type, "Content-Length": str(len(body)),
                            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                            "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
                            **(headers or {})}.items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # A closed/reloaded tab is not a service failure; do not print its request.

    def _host_ok(self):
        return self.headers.get("Host") == urlsplit(self.server.origin).netloc

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def _authenticated(self):
        try:
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            value = cookies.get("ds_friend")
            return value is not None and same(value.value, self.server.session)
        except (ValueError, TypeError, CookieError):
            return False

    def do_GET(self):
        if not self._host_ok():
            return self._reply(403, {"error": "host-rejected"})
        target = urlsplit(self.path)
        if target.path == "/" and "ticket" in parse_qs(target.query):
            ticket = parse_qs(target.query)["ticket"][0]
            if self.server.ticket and same(ticket, self.server.ticket):
                self.server.ticket = ""  # Single-use exchange. Clean URL after redirect.
                return self._reply(303, headers={"Location": "/", "Set-Cookie": "ds_friend=" + self.server.session + "; HttpOnly; SameSite=Strict; Path=/"})
        if not self._authenticated():
            return self._reply(403, "请使用启动器自动打开的浏览器窗口；关闭启动器后重新运行可重新打开。", "text/plain; charset=utf-8")
        assets = {"/": ("index.html", "text/html; charset=utf-8"),
                  "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/style.css": ("style.css", "text/css; charset=utf-8")}
        if target.path in assets:
            filename, mime = assets[target.path]
            return self._reply(200, (ROOT / "web" / filename).read_bytes(), mime)
        if target.path == "/api/state":
            return self._reply(200, {**self.server.controller.snapshot(), "csrf": self.server.csrf})
        if target.path == "/api/qq-qr.svg":
            with self.server.controller.lock:
                svg = self.server.controller.qq_svg
            return self._reply(200 if svg else 404, svg or "", "image/svg+xml")
        if target.path == "/api/qr.svg":
            with self.server.controller.lock:
                svg = self.server.controller.svg
            return self._reply(200, svg, "image/svg+xml") if svg else self._reply(404, {"error": "qr-unavailable"})
        return self._reply(404, {"error": "not-found"})

    def do_POST(self):
        if (not self._host_ok() or not self._authenticated()
                or self.headers.get("Origin") != self.server.origin
                or not same(self.headers.get("X-CSRF-Token", ""), self.server.csrf)):
            return self._reply(403, {"error": "request-rejected"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            limit = 65536 if self.path == "/api/sessions" else 1024
            if not 0 < size <= limit or self.headers.get_content_type() != "application/json":
                raise ValueError()
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, TypeError):
            return self._reply(400, {"error": "invalid-request"})
        try:
            if self.path == "/api/verify":
                self.server.controller.verify(data.get("id"), data.get("code"))
            elif self.path == "/api/action":
                self.server.controller.enqueue(data.get("action"))
            elif self.path == "/api/sessions":
                return self._reply(200, self.server.controller.sessions(data.get("action"), data.get("args")))
            elif self.path == "/api/quit":
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                return self._reply(404, {"error": "not-found"})
        except LauncherError as exc:
            return self._reply(409, {"error": str(exc)})
        return self._reply(202, {"ok": True})


def main():
    parser = argparse.ArgumentParser(description="DeepSeek:Friend 本地 Web 启动器")
    parser.add_argument("--port", type=int, default=3090)
    parser.add_argument("--no-browser", action="store_true", help="仅运行服务，不自动打开浏览器")
    parser.add_argument("--start", action="store_true", help="打开控制台后自动启动独立 DSH、Bridge 和已安装的 QQ Bot")
    args = parser.parse_args()
    controller = Controller(auto_qq=True)
    try:
        server = LocalServer(("127.0.0.1", args.port), controller)
    except OSError:
        controller.close()
        print("启动失败：Web UI 端口已被占用或不可用，请检查原启动器或通过 --port 指定其他端口。")
        return 1
    # Avoid running shutdown() on the serving thread (would deadlock).
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"DeepSeek:Friend {VERSION} · 本地控制台 {server.origin}", flush=True)
    print("浏览器将自动打开。请点击「一键启动全部」；关闭此终端会停止本启动器管理的服务。", flush=True)
    if not args.no_browser:
        webbrowser.open(server.launch_url())
    if args.start:
        controller.enqueue("start")
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        controller.close()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
