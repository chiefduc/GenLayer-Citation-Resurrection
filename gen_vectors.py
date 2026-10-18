"""Shared loader for the contract module + generator for Python/JS parity vectors.

Run from the repo root:  python tests/gen_vectors.py
frontend/test/urls.test.mjs must reproduce every vector (normalize + snapshot parse).
"""
import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_contract():
    class _Sub:
        def __class_getitem__(cls, item):
            return cls

    class UserError(Exception):
        pass

    gl = types.SimpleNamespace(
        Contract=object,
        public=types.SimpleNamespace(view=lambda f: f, write=lambda f: f),
        vm=types.SimpleNamespace(UserError=UserError, Return=object),
        message=types.SimpleNamespace(sender_address=None),
    )
    stub = types.ModuleType("genlayer")
    stub.gl = gl
    stub.allow_storage = lambda c: c
    stub.TreeMap = type("TreeMap", (_Sub,), {})
    stub.Address = type("Address", (), {})
    stub.u256 = int
    sys.modules["genlayer"] = stub
    spec = importlib.util.spec_from_file_location("cr", ROOT / "contracts" / "citation_resurrection.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, UserError


NORMALIZE_INPUTS = [
    "https://example.com/post",
    "http://example.com/post",
    "https://www.Example.COM/post/",
    "https://example.com/post#section-2",
    "https://example.com:443/post",
    "http://example.com:80/post",
    "https://example.com",
    "https://example.com/",
    "https://example.com///",
    "https://example.com/a/b/c.html?x=1&y=2",
    "https://example.com/a/b/?x=1",
    "https://example.com/Case/Sensitive",
    "  https://example.com/padded  ",
    "https://sub.example.co.uk/p?q=A#frag",
    "HTTPS://EXAMPLE.COM/Upper",
    "example.com/no-scheme/",
    "https://example.com?Q=1",
    "https://Example.com/?Q=1#x",
    "http://example.com:8080/path/",
]

SNAPSHOT_CASES = [
    ("https://web.archive.org/web/20190302123456/https://example.com/post", "https://example.com/post"),
    ("https://web.archive.org/web/20190302123456id_/https://example.com/post", "https://example.com/post"),
    ("https://web.archive.org/web/20190302123456if_/http://www.example.com/post/", "https://example.com/post"),
    ("https://web.archive.org/web/20190302123456/example.com/post", "https://example.com/post"),
    ("https://web.archive.org/web/20190302123456/https://example.com/other", "https://example.com/post"),
    ("https://web.archive.org/web/2019030212345/https://example.com/post", "https://example.com/post"),
    ("https://web.archive.org/web/20191302123456/https://example.com/post", "https://example.com/post"),
    ("https://web.archive.org/web/20190302123456/", "https://example.com/post"),
    ("https://web.archive.org/web/*/https://example.com/post", "https://example.com/post"),
    ("http://web.archive.org/web/20190302123456/https://example.com/post", "https://example.com/post"),
    ("https://web.archive.org.evil.com/web/20190302123456/https://example.com/post", "https://example.com/post"),
    ("https://web.archive.org/web/20190302123456id/https://example.com/post", "https://example.com/post"),
    ("https://example.com/web/20190302123456/https://example.com/post", "https://example.com/post"),
]


def main():
    mod, _ = load_contract()
    out = {
        "normalize": [{"input": u, "expected": mod.normalize_url(u)} for u in NORMALIZE_INPUTS],
        "snapshot": [
            {"snapshot": s, "dead": d, "expected": mod.parse_snapshot_url(s, d)} for s, d in SNAPSHOT_CASES
        ],
    }
    path = ROOT / "tests" / "vectors.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(out['normalize'])} normalize + {len(out['snapshot'])} snapshot vectors to {path}")


if __name__ == "__main__":
    main()
