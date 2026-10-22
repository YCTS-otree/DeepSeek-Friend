import http.client
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import unittest
import tempfile
import os
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launcher import Controller, LauncherError, LocalServer, ROOT


def qr_svg():
    result = subprocess.run(["node", "--input-type=module", "-e",
                             "import {qrSvg} from './src/launcher-io.js'; console.log(qrSvg('https://example.org/login?fixture=web-qr'));"],
                            cwd=ROOT, capture_output=True, text=True, check=True)
    return result.stdout.strip()


class StateTests(unittest.TestCase):
    def setUp(self):
        self.c = Controller()

    def tearDown(self):
        self.c.close()

    def test_login_state_and_no_secret_in_snapshot(self):
        svg = qr_svg()
        self.c._event("bridge", {"event": "ui.qr", "svg": svg})
        s = self.c.snapshot()
        self.assertTrue(s["hasQr"])
        self.assertNotIn("<svg", json.dumps(s))
        self.c._event("bridge", {"event": "ui.login", "state": "scanned"})
        self.assertEqual(self.c.snapshot()["login"], "scanned")
        self.c._event("bridge", {"event": "ui.login", "state": "refreshing"})
        self.assertFalse(self.c.snapshot()["hasQr"])
        self.c._event("bridge", {"event": "ui.qr", "svg": '<svg onload="alert(1)"/>'})
        self.assertFalse(self.c.snapshot()["hasQr"])

    def test_verification_bound_and_not_logged(self):
        request_id = "12345678-1234-1234-1234-123456789abc"
        self.c._event("bridge", {"event": "ui.verify", "id": request_id})
        with self.assertRaises(LauncherError):
            self.c.verify("another", "123456")
        with self.assertRaises(LauncherError):
            self.c.verify(request_id, "12&3")
        with patch.object(self.c, "_send", return_value=True) as send:
            self.c.verify(request_id, "012345")
            send.assert_called_once_with("bridge", {"command": "verify", "id": request_id, "code": "012345"})
        with self.assertRaises(LauncherError):
            self.c.verify(request_id, "012345")
        self.assertNotIn("012345", json.dumps(self.c.snapshot()))

    def test_auth_expiry_clears_qr_and_verification(self):
        self.c._event("bridge", {"event": "ui.qr", "svg": qr_svg()})
        self.c._event("bridge", {"event": "bridge.failed", "code": "ilink-auth-expired"})
        s = self.c.snapshot()
        self.assertFalse(s["hasQr"])
        self.assertIsNone(s["verifyId"])
        self.assertEqual(s["error"], "ilink-auth-expired")

    def test_unknown_output_and_secret_fields_not_forwarded(self):
        self.c._event("dsh", {"event": "dsh.independent-ready", "token": "not-a-real-token"})
        self.c._event("dsh", {"event": "https://secret.example", "code": "credential=value"})
        snapshot = json.dumps(self.c.snapshot())
        self.assertNotIn("not-a-real-token", snapshot)
        self.assertNotIn("secret.example", snapshot)

    def test_session_ipc_routes_private_history_only_to_the_waiting_request(self):
        def reply(_name, message):
            self.c._event("bridge", {"event": "ui.sessions", "id": message["id"], "result": {"entries": [{"text": "private-test-history"}]}})
            return True
        with patch.object(self.c, "_alive", return_value=True), patch.object(self.c, "_send", side_effect=reply):
            self.assertEqual(self.c.sessions("history", {"session": "fixture"})["entries"][0]["text"], "private-test-history")
        self.assertNotIn("private-test-history", json.dumps(self.c.snapshot()))
        self.assertEqual(self.c.session_requests, {})

    def test_stopped_service_session_management_is_persistent_and_isolated(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".research") as temp:
            config = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
            config["dataDir"] = str(Path(temp) / "data")
            file = Path(temp) / "config.json"
            file.write_text(json.dumps(config), encoding="utf-8")
            with patch.dict(os.environ, {"BRIDGE_CONFIG": str(file)}):
                first = self.c.sessions("create", {"title": "第一段对话"})["session"]
                second = self.c.sessions("create", {"title": "第二段对话"})["session"]
                self.assertNotEqual(first, second)
                self.c.sessions("switch", {"session": first})
                rows = self.c.sessions("list")["sessions"]
                self.assertEqual(next(s for s in rows if s["archived"] == 0)["session"], first)
                self.assertEqual(len(rows), 2)
                with self.assertRaises(LauncherError):
                    self.c.sessions("delete", {"session": second})
                for bad in [[], {}, None]:
                    with self.assertRaises(LauncherError):
                        self.c.sessions(bad)

    def test_occupied_port_does_not_spawn_or_stop_external_process(self):
        import socket
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        try:
            with patch("launcher.subprocess.run") as run, patch.object(self.c, "_spawn") as spawn:
                run.return_value.returncode = 0
                run.return_value.stdout = json.dumps({"baseUrl": f"http://127.0.0.1:{port}"})
                with self.assertRaisesRegex(LauncherError, "dsh-port-in-use"):
                    self.c._start()
                spawn.assert_not_called()
                self.assertEqual(listener.getsockname()[1], port)
        finally:
            listener.close()

    def test_stop_owned_child_and_restart(self):
        # A real controllable fake child exercises stdin shutdown and process cleanup without DSH.
        child = subprocess.Popen([sys.executable, "-u", "-c", "import sys; sys.stdin.readline()"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.c.children["bridge"] = child
        self.c._stop_child("bridge")
        self.assertIsNotNone(child.poll())
        self.assertEqual(self.c.snapshot()["bridge"], "stopped")
        child.stdout.close()

    def test_dsh_death_stops_bridge(self):
        child = subprocess.Popen([sys.executable, "-u", "-c", "pass"], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, text=True)
        self.c.children["dsh"] = child
        with patch.object(self.c, "_send", return_value=True) as send:
            self.c._read("dsh", child, "start")
            send.assert_called_with("bridge", {"command": "shutdown"})
        child.stdin.close()
        self.assertEqual(self.c.snapshot()["error"], "dsh-exited")

    def test_two_full_starts_stops_and_relogin_use_owned_node_children(self):
        original_spawn = self.c._spawn
        def spawn(name, args, mode="start"):
            event = "dsh.independent-ready" if name == "dsh" else "weixin.login-success" if mode == "login" else "bridge.started"
            code = "console.log(JSON.stringify({event:" + json.dumps(event) + "}));"
            code += "process.exit(0)" if mode == "login" else "require('readline').createInterface({input:process.stdin}).on('line',()=>process.exit(0));"
            return original_spawn(name, ["-e", code], mode)
        def wait_for(predicate):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if predicate():
                    return
                time.sleep(0.02)
            self.fail("supervisor operation timed out")
        with patch.object(self.c, "_spawn", side_effect=spawn), patch("launcher.subprocess.run") as run:
            run.return_value.returncode = 0
            # Test fixture only: select an unused local port; no real DSH is required.
            import socket
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            run.return_value.stdout = json.dumps({"baseUrl": f"http://127.0.0.1:{port}"})
            for _ in range(2):
                self.c.enqueue("start")
                wait_for(lambda: self.c.snapshot()["bridge"] == "ready" and not self.c.snapshot()["busy"])
                self.c.enqueue("login")
                wait_for(lambda: self.c.snapshot()["bridge"] == "ready" and not self.c.snapshot()["busy"])
                self.c.enqueue("stop")
                wait_for(lambda: self.c.snapshot()["dsh"] == "stopped" and not self.c.snapshot()["busy"])
                self.assertEqual(self.c.children, {})
                self.assertIsNone(self.c.snapshot()["error"])


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.c = Controller()
        self.server = LocalServer(("127.0.0.1", 0), self.c)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host = f"127.0.0.1:{self.server.server_port}"
        _, _, headers = self.request("GET", "/?ticket=" + self.server.ticket)
        self.cookie = headers["Set-Cookie"].split(";")[0]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.c.close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request(method, path, body, headers or {})
            response = conn.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            conn.close()

    def auth_headers(self):
        return {"Cookie": self.cookie, "Origin": self.server.origin,
                "X-CSRF-Token": self.server.csrf, "Content-Type": "application/json"}

    def test_unauthenticated_cannot_access_state_or_assets(self):
        for path in ["/api/state", "/api/qr.svg", "/app.js", "/"]:
            self.assertEqual(self.request("GET", path)[0], 403)

    def test_ticket_single_use_and_cookie_http_only(self):
        self.assertEqual(self.server.ticket, "")
        status, _, headers = self.request("GET", "/?ticket=replayed")
        self.assertEqual(status, 403)
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.request("GET", "/?ticket=%E4%B8%AD")[0], 403)

    def test_authenticated_assets_and_no_arbitrary_files(self):
        for path in ["/", "/app.js", "/style.css", "/api/state"]:
            status, _, headers = self.request("GET", path, headers={"Cookie": self.cookie})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        for path in ["/../launcher.py", "/config.json", "/DEEPSEEK_FRIEND.key", "/.runtime/home/.credentials.yaml"]:
            self.assertEqual(self.request("GET", path, headers={"Cookie": self.cookie})[0], 404)

    def test_cross_origin_csrf_and_host_rejected(self):
        headers = self.auth_headers()
        for field, value in [("Origin", "https://evil.example"), ("X-CSRF-Token", "bad"), ("Host", "evil.example")]:
            with self.subTest(field=field):
                h = {**headers, field: value}
                self.assertEqual(self.request("POST", "/api/action", '{"action":"start"}', h)[0], 403)
        self.assertEqual(self.request("GET", "/api/state", headers={"Cookie": self.cookie, "Host": "evil.example"})[0], 403)

    def test_actions_validation_and_payload_limit(self):
        h = self.auth_headers()
        with patch.object(self.c, "enqueue") as enqueue:
            self.assertEqual(self.request("POST", "/api/action", '{"action":"start"}', h)[0], 202)
            enqueue.assert_called_once_with("start")
        self.assertEqual(self.request("POST", "/api/action", "[]", h)[0], 400)
        self.assertEqual(self.request("POST", "/api/action", "x" * 1025, h)[0], 400)
        self.assertEqual(self.request("POST", "/api/action", '{"action":"shell"}', h)[0], 409)
        self.assertEqual(self.request("POST", "/api/action", '{"action":[]}', h)[0], 409)
        self.assertEqual(self.request("GET", "/api/action", headers=h)[0], 404)

    def test_session_history_requires_cookie_origin_and_csrf(self):
        body = json.dumps({"action": "history", "args": {"session": "fixture"}})
        self.assertEqual(self.request("POST", "/api/sessions", body, {"Content-Type": "application/json"})[0], 403)
        with patch.object(self.c, "sessions", return_value={"entries": [{"role": "assistant", "text": "saved output"}]}) as sessions:
            status, content, _ = self.request("POST", "/api/sessions", body, self.auth_headers())
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(content)["entries"][0]["text"], "saved output")
            sessions.assert_called_once_with("history", {"session": "fixture"})

    def test_qr_is_image_not_in_state_and_cleared_on_stop(self):
        self.c._event("bridge", {"event": "ui.qr", "svg": qr_svg()})
        status, data, headers = self.request("GET", "/api/qr.svg", headers={"Cookie": self.cookie})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertTrue(data.startswith(b"<svg"))
        self.c._stop_all()
        self.assertEqual(self.request("GET", "/api/qr.svg", headers={"Cookie": self.cookie})[0], 404)


class QRDecodeTests(unittest.TestCase):
    def test_encoded_modules_decode_with_opencv_when_available(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("Optional local QR decoder unavailable; Node SVG structure test still runs")
        svg = qr_svg()
        size = int(re.search(r'viewBox="0 0 (\d+) ', svg)[1])
        image = np.full((size, size), 255, dtype=np.uint8)
        for x, y in re.findall(r"M(\d+) (\d+)h1v1h-1z", svg):
            image[int(y), int(x)] = 0
        image = cv2.resize(image, (size * 8, size * 8), interpolation=cv2.INTER_NEAREST)
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
        self.assertEqual(decoded, "https://example.org/login?fixture=web-qr")


if __name__ == "__main__":
    unittest.main()
