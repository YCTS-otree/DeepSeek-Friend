"""CPU token accounting: official tokenizer assets, with provider usage kept distinct."""
from pathlib import Path
import hashlib
import json

from .model import MemoryError


class CpuTokenCounter:
    def __init__(self, directory):
        from tokenizers import Tokenizer
        from jinja2.sandbox import ImmutableSandboxedEnvironment
        self.directory = Path(directory)
        self.tokenizer = Tokenizer.from_file(str(self.directory / "tokenizer.json"))
        self.config = json.loads((self.directory / "tokenizer_config.json").read_text(encoding="utf-8"))
        self.template = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True).from_string(self.config["chat_template"])
        self.identity = hashlib.sha256((self.directory / "tokenizer.json").read_bytes()).hexdigest()

    def count_text(self, text):
        return len(self.tokenizer.encode(text, add_special_tokens=False).ids)

    def count_messages(self, messages):
        if any(m.get("role") not in {"system", "user", "assistant", "tool"} or not isinstance(m.get("content"), str) for m in messages):
            raise MemoryError("token-counter-requires-normalized-messages")
        rendered = self.template.render(messages=messages, add_generation_prompt=True,
                                        bos_token=self.config.get("bos_token", ""), eos_token=self.config.get("eos_token", ""))
        return self.count_text(rendered)

    def report(self, messages):
        return {"local_tokens": self.count_messages(messages), "method": "official-v4-tokenizer/chat-template", "tokenizer_sha256": self.identity,
                "device": "cpu", "provider_envelope_tokens": None, "note": "Full provider framing/tools/images require API usage verification; local text token counts are not relabeled as billing usage."}
