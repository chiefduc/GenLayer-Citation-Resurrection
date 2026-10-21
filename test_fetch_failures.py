"""Original-page fetch failures must be inconclusive and retryable, never a case.

Runs the real CitationResurrection contract against an in-memory stand-in for the
GenLayer SDK. The leader and the validator each fetch and prompt on their own, so
the tests can make them see different things.

    pip install pytest
    python3 -m pytest -q tests/test_fetch_failures.py

The contract file is found automatically (any contracts/*.py defining
CitationResurrection); set CITATION_CONTRACT=path/to/file.py to override.
"""

import dataclasses
import importlib.util
import json
import os
import pathlib
import sys
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- SDK stand-in


class u256(int):
    pass


class TreeMap(dict):
    pass


class Address:
    def __init__(self, hex_str: str):
        self.as_hex = hex_str

    def __eq__(self, other):
        return isinstance(other, Address) and other.as_hex.lower() == self.as_hex.lower()

    def __hash__(self):
        return hash(self.as_hex.lower())


def allow_storage(cls):
    return cls


class UserError(Exception):
    pass


class Undetermined(Exception):
    """Validators rejected the leader's result: the transaction stores nothing."""


class NondetException(Exception):
    """What the SDK raises when a fetch fails (DNS, TLS, timeout, connection)."""


@dataclasses.dataclass
class Return:
    calldata: object


@dataclasses.dataclass
class LeaderFailed:
    exc: Exception


@dataclasses.dataclass
class Response:
    status: int
    headers: dict
    body: bytes


class World:
    """What the leader and the validator see. Values may be callables taking the role."""

    def __init__(self):
        self.sender = "0x" + "a" * 40
        self.role = None
        self.status = {}  # url -> int | Exception | callable(role)
        self.text = {}  # url -> str | Exception | callable(role)
        self.liveness_reply = {"original_present": False, "temporary_error": False}
        self.open_reply = None  # defaults to YES for every fact
        self.proposal_reply = {"relation": "SAME_DOCUMENT", "facets": None}
        self.has_get = True

    def _pick(self, table, url):
        v = table.get(url)
        if callable(v):
            v = v(self.role)
        if isinstance(v, Exception):
            raise v
        return v

    def get(self, url, **_):
        status = self._pick(self.status, url)
        if status is None:
            raise NondetException("connection failed")
        return Response(status=status, headers={}, body=b"")

    def render(self, url, mode="text", **_):
        text = self._pick(self.text, url)
        if text is None:
            raise NondetException("render failed")
        return text

    def prompt(self, p):
        n = sum(1 for ln in p.splitlines() if ln[:1].isdigit() and ln[1:3] == ". ")  # numbered facts
        if p.startswith("You are verifying a citation"):
            reply = self.open_reply or {"facets": ["YES"] * n}
        elif p.startswith("A web page has an archived snapshot"):
            reply = self.liveness_reply
        else:
            reply = dict(self.proposal_reply)
            reply["facets"] = reply["facets"] or ["YES"] * n
        reply = reply(self.role) if callable(reply) else reply
        return reply if isinstance(reply, str) else json.dumps(reply)


W = World()


def run_nondet_unsafe(leader, validator):
    W.role = "leader"
    try:
        res = Return(leader())
    except Exception as e:
        res = LeaderFailed(e)
    W.role = "validator"
    try:
        agreed = validator(res)
    finally:
        W.role = None
    if not agreed:
        raise Undetermined("validators disagreed")
    if isinstance(res, LeaderFailed):
        raise res.exc  # leader error confirmed: the transaction fails, nothing stored
    return res.calldata


class _Web:
    def render(self, url, mode="text", **kw):
        return W.render(url, mode, **kw)

    def __getattr__(self, name):
        if name == "get" and W.has_get:
            return W.get
        raise AttributeError(name)


class _Message:
    @property
    def sender_address(self):
        return Address(W.sender)


class Contract:
    def __new__(cls, *a, **kw):
        obj = super().__new__(cls)
        for name, ann in getattr(cls, "__annotations__", {}).items():
            if ann is TreeMap or getattr(ann, "__origin__", None) is TreeMap:
                setattr(obj, name, TreeMap())
        return obj


def _identity(fn):
    return fn


gl = types.SimpleNamespace(
    Contract=Contract,
    public=types.SimpleNamespace(write=_identity, view=_identity),
    message=_Message(),
    message_raw={"datetime": "2026-10-21T12:00:00+00:00"},
    vm=types.SimpleNamespace(UserError=UserError, Return=Return, run_nondet_unsafe=run_nondet_unsafe),
    nondet=types.SimpleNamespace(web=_Web(), exec_prompt=lambda p: W.prompt(p)),
)


def _find_contract() -> pathlib.Path:
    override = os.environ.get("CITATION_CONTRACT")
    if override:
        return pathlib.Path(override)
    for path in sorted((ROOT / "contracts").glob("*.py")) + sorted(ROOT.glob("*.py")):
        if "original" in path.name:
            continue
        if "class CitationResurrection" in path.read_text(encoding="utf-8"):
            return path
    raise FileNotFoundError("could not find the CitationResurrection contract; set CITATION_CONTRACT")


def _load_contract():
    fake = types.ModuleType("genlayer")
    fake.gl, fake.TreeMap, fake.u256, fake.Address, fake.allow_storage = gl, TreeMap, u256, Address, allow_storage
    fake.__all__ = ["gl", "TreeMap", "u256", "Address", "allow_storage"]
    saved = sys.modules.get("genlayer")
    sys.modules["genlayer"] = fake
    try:
        spec = importlib.util.spec_from_file_location("citation_resurrection_under_test", _find_contract())
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        if saved is None:
            sys.modules.pop("genlayer", None)
        else:
            sys.modules["genlayer"] = saved
    return mod


cr = _load_contract()

# --------------------------------------------------------------------------- fixtures

DEAD = "https://example.com/2019/report"
SNAP = "https://web.archive.org/web/20190302123456/https://example.com/2019/report"
CONTEXT = "Rainfall in Port Avery fell by a third in 2018 (example.com, 2019)."
FACTS = ["Rainfall in Port Avery fell by a third in 2018", "The figures come from the Port Avery weather office"]
SNAP_TEXT = "Port Avery weather office annual report 2018. Rainfall in Port Avery fell by a third in 2018."
LIVE_SAME = "Port Avery weather office annual report 2018. Rainfall fell by a third. (new site layout)"


@pytest.fixture(autouse=True)
def world():
    fresh = World()
    W.__dict__.clear()
    W.__dict__.update(fresh.__dict__)
    W.text[SNAP] = SNAP_TEXT
    return W


@pytest.fixture
def c():
    return cr.CitationResurrection()


def open_case(c):
    return c.open_case(DEAD, SNAP, CONTEXT, list(FACTS))


def assert_no_case(c):
    assert c.get_count() == 0
    assert c.lookup(DEAD) == []
    assert len(c.cases) == 0 and len(c.by_key) == 0 and len(c.ids_by_url) == 0
    assert int(c.open_by_reporter.get(W.sender.lower(), 0)) == 0


# --------------------------------------------------------------------------- the steward's case


def test_temporary_fetch_failure_stores_no_case(c):
    """Connection fails for everyone: retryable result, nothing stored."""
    W.status[DEAD] = NondetException("timed out")
    result = open_case(c)
    assert result == {"accepted": False, "reason": cr.REASON_UNREACHABLE, "retryable": True}
    assert_no_case(c)
    report = c.get_last_report(W.sender)
    assert report["retryable"] is True and report["evidence"]["dead"] == cr.UNREACHABLE


def test_same_report_can_be_retried_after_a_failure(c):
    """The failure leaves no duplicate key behind, so a later retry can succeed."""
    W.status[DEAD] = NondetException("timed out")
    assert open_case(c)["accepted"] is False
    W.status[DEAD] = 404
    assert open_case(c) == {"accepted": True, "case_id": 0}
    assert c.get_count() == 1


@pytest.mark.parametrize("status", [500, 502, 503, 504, 429, 408, 403, 401, 451, 999])
def test_error_statuses_are_inconclusive(c, status):
    W.status[DEAD] = status
    assert open_case(c)["reason"] == cr.REASON_UNREACHABLE
    assert_no_case(c)


def test_render_failure_after_ok_status_is_inconclusive(c):
    W.status[DEAD] = 200  # W.text has no entry for DEAD, so render fails
    assert open_case(c)["reason"] == cr.REASON_UNREACHABLE
    assert_no_case(c)


def test_blank_render_is_inconclusive(c):
    W.status[DEAD], W.text[DEAD] = 200, "   \n "
    assert open_case(c)["reason"] == cr.REASON_UNREACHABLE
    assert_no_case(c)


def test_maintenance_or_bot_check_page_is_inconclusive(c):
    W.status[DEAD], W.text[DEAD] = 200, "Checking your browser before accessing example.com"
    W.liveness_reply = {"original_present": False, "temporary_error": True}
    assert open_case(c)["reason"] == cr.REASON_UNREACHABLE
    assert_no_case(c)


@pytest.mark.parametrize("reply", [{"original_present": False}, {"original_present": False, "temporary_error": "no"}])
def test_missing_temporary_flag_fails_closed(c, reply):
    W.status[DEAD], W.text[DEAD] = 200, "Page not found"
    W.liveness_reply = reply
    assert open_case(c)["reason"] == cr.REASON_UNREACHABLE
    assert_no_case(c)


def test_leader_cannot_fetch_but_validator_can_stores_nothing(c):
    W.status[DEAD] = lambda role: NondetException("timeout") if role == "leader" else 404
    with pytest.raises(Undetermined):
        open_case(c)
    assert_no_case(c)


def test_validator_cannot_fetch_but_leader_can_stores_nothing(c):
    W.status[DEAD] = lambda role: 404 if role == "leader" else NondetException("timeout")
    with pytest.raises(Undetermined):
        open_case(c)
    assert_no_case(c)


def test_without_status_api_a_render_failure_is_still_inconclusive(c):
    """Fallback for SDK builds without gl.nondet.web.get."""
    W.has_get = False
    assert open_case(c)["reason"] == cr.REASON_UNREACHABLE
    assert_no_case(c)


def test_snapshot_fetch_failure_stores_nothing(c):
    W.text[SNAP] = NondetException("archive timed out")
    W.status[DEAD] = 404
    with pytest.raises(NondetException):
        open_case(c)
    assert_no_case(c)


# --------------------------------------------------------------------------- definite answers still work


def test_404_opens_a_case(c):
    W.status[DEAD] = 404
    assert open_case(c) == {"accepted": True, "case_id": 0}
    case = c.get_case(0)
    assert case["evidence"]["dead"] == cr.DEAD_HTTP and case["status"] == cr.ST_OPEN


def test_410_opens_a_case(c):
    W.status[DEAD] = 410
    assert open_case(c)["accepted"] is True


def test_soft_404_opens_a_case(c):
    W.status[DEAD], W.text[DEAD] = 200, "Sorry, this page does not exist. Browse our latest news."
    W.liveness_reply = {"original_present": False, "temporary_error": False}
    assert open_case(c)["accepted"] is True
    assert c.get_case(0)["evidence"]["dead"] == cr.DEAD_SOFT


def test_alive_page_opens_no_case(c):
    W.status[DEAD], W.text[DEAD] = 200, LIVE_SAME
    W.liveness_reply = {"original_present": True, "temporary_error": False}
    assert open_case(c) == {"accepted": False, "reason": cr.REASON_ALIVE, "retryable": False}
    assert_no_case(c)


def test_garbled_liveness_reply_opens_no_case(c):
    W.status[DEAD], W.text[DEAD] = 200, LIVE_SAME
    W.liveness_reply = "I think the page is gone"
    assert open_case(c)["reason"] == cr.REASON_ALIVE
    assert_no_case(c)


def test_replacement_fetch_failure_records_no_proposal(c):
    W.status[DEAD] = 404
    open_case(c)
    W.sender = "0x" + "b" * 40
    with pytest.raises(NondetException):
        c.propose(0, "https://mirror.example.org/report-2018")  # not in W.text: render fails
    assert c.get_case(0)["proposal_count"] == 0


# --------------------------------------------------------------------------- pure helpers


@pytest.mark.parametrize("status,bucket", [
    (404, cr.DEAD_HTTP), (410, cr.DEAD_HTTP), (200, "LOADED"), (301, "LOADED"),
    (500, cr.UNREACHABLE), (429, cr.UNREACHABLE), (403, cr.UNREACHABLE), (None, cr.UNREACHABLE), (True, cr.UNREACHABLE),
])
def test_status_bucket(status, bucket):
    assert cr.status_bucket(status) == bucket


@pytest.mark.parametrize("raw,state", [
    ('{"original_present": true, "temporary_error": false}', cr.ALIVE),
    ('{"original_present": false, "temporary_error": false}', cr.DEAD_SOFT),
    ('{"original_present": false, "temporary_error": true}', cr.UNREACHABLE),
    ('{"original_present": false}', cr.UNREACHABLE),
    ("```json\n{\"original_present\": false, \"temporary_error\": false}\n```", cr.DEAD_SOFT),
    ("not json", cr.ALIVE),
    ("[]", cr.ALIVE),
])
def test_parse_liveness(raw, state):
    assert cr.parse_liveness(raw) == state


def test_unreachable_never_agrees_with_dead():
    lead = {"dead": cr.UNREACHABLE, "levels": ["YES", "YES"]}
    assert not cr.open_compatible(lead, {"dead": cr.DEAD_HTTP, "levels": ["YES", "YES"]})
    assert not cr.open_compatible(lead, {"dead": cr.ALIVE, "levels": ["YES", "YES"]})
    assert cr.open_compatible(lead, {"dead": cr.UNREACHABLE, "levels": ["NO", "YES"]})
    assert cr.open_compatible({"dead": cr.DEAD_HTTP, "levels": ["YES"]}, {"dead": cr.DEAD_SOFT, "levels": ["YES"]})
