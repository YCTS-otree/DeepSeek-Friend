"""Audited, resumable LLM requests outside an Agent runtime."""
from pathlib import Path
import json
import subprocess
import time

from .model import MemoryError, canonical, digest
from .atomic_io import atomic_json


class RemoteProvider:
    def __init__(self, dsf_root, output_dir, *, model="deepseek-flash"):
        self.dsf_root = Path(dsf_root).resolve()
        self.output = Path(output_dir)
        self.output.mkdir(parents=True, exist_ok=True)
        self.worker = Path(__file__).resolve().parents[2] / "adapters/dsh/remote-provider.mjs"
        self.model = model

    def request(self, messages, *, max_tokens=4096, json_output=True, label="llm"):
        request = {"messages": messages, "max_tokens": max_tokens, "json": json_output, "model": self.model}
        fingerprint = digest(request)
        file = self.output / (label + "-" + fingerprint[:20] + ".json")
        if file.exists():
            cached = json.loads(file.read_text(encoding="utf-8"))
            if cached["request_digest"] != fingerprint:
                raise MemoryError("llm-receipt-collision")
            if cached.get("success"):
                return cached["response"]
        started = time.perf_counter()
        try:
            result = subprocess.run(["node", str(self.worker), str(self.dsf_root)], input=canonical(request).encode("utf-8"), capture_output=True, timeout=260)
            try:
                response = json.loads(result.stdout)
            except (ValueError, UnicodeDecodeError):
                response = {"error": "provider-invalid-transport"}
            succeeded = result.returncode == 0 and not response.get("error")
        except subprocess.TimeoutExpired:
            response, succeeded = {"error": "provider-transport-timeout"}, False
        record = {"request_digest": fingerprint, "request": request, "response": response,
                  "elapsed_seconds": time.perf_counter() - started, "success": succeeded}
        # Requests and responses are private experiment data, never console output or source control.
        if file.exists():
            failure = file.with_name(file.stem + "-failed-" + str(time.time_ns()) + ".json")
            file.rename(failure)
        atomic_json(file,record)
        if not record["success"]:
            raise MemoryError(response.get("error", "provider-failed"))
        return response

    def json(self, system, payload, *, max_tokens=4096, label="llm"):
        response = self.request([{"role": "system", "content": system}, {"role": "user", "content": canonical(payload)}], max_tokens=max_tokens, label=label)
        try:
            return json.loads(response["content"]), response
        except (ValueError, TypeError, KeyError):
            raise MemoryError("provider-invalid-json") from None
