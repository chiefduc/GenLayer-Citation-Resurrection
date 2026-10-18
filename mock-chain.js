// DEMO MODE ONLY (npm run dev:demo / build:demo). A simulated chain kept in this
// browser's localStorage so the whole interface can be tried without a node.
// It follows the contract's rules (case creation, one winner per case, no credit
// for healing your own case) but the "validators" are FAKE and decide from
// keywords:
//   - a link counts as dead unless its address contains "alive"
//   - a snapshot supports every fact unless a fact contains "false"
//   - a replacement containing "same" is the same document, "other" an independent
//     source, "weak" partial support; anything else is unrelated
// It is never part of the normal build.
import { normalizeUrl } from "../urls.js";

export const NETWORKS = {
  studionet: { label: "Demo chain (simulated)", chain: {} },
  localnet: { label: "Demo chain (simulated)", chain: {} },
  testnetBradbury: { label: "Demo chain (simulated)", chain: {} },
  testnetAsimov: { label: "Demo chain (simulated)", chain: {} },
};

const DB_KEY = "cr.demo.db";
const DEMO_ADDRESS = "0x" + "de".repeat(20);
const OTHER = "0x" + "a1".repeat(20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const levelsOf = (n, v) => Array(n).fill(v);
const proposal = (url, relation, levels, verdict, bps, finder = OTHER) => ({
  url, finder, relation, levels, verdict, fidelity_bps: bps, proposed_on: "2026-10-03",
});

function seed() {
  return {
    cases: [
      {
        id: 0,
        reporter: OTHER,
        dead_url: "https://old-blog.example.com/sleep-debt-study",
        snapshot_url: "https://web.archive.org/web/20190302123456/https://old-blog.example.com/sleep-debt-study",
        snapshot_date: "2019-03-02",
        context: "Sleep debt accumulates over a week, and weekend recovery sleep does not fully reverse it.",
        facets: ["Sleep debt accumulates over a week", "Weekend recovery sleep does not fully reverse it"],
        evidence: { dead: "DEAD_HTTP", levels: ["YES", "YES"] },
        status: "HEALED",
        opened_on: "2026-10-01",
        replacement_url: "https://journal.example.org/articles/sleep-debt",
        proposals: [
          proposal("https://news.example.net/sleep-weekend", "DIFFERENT_SOURCE", ["PARTIAL", "NO"], "REJECTED", 2500),
          proposal("https://journal.example.org/articles/sleep-debt", "DIFFERENT_SOURCE", ["YES", "YES"], "HEALED_INDEPENDENT_SOURCE", 10000),
        ],
        winner: 2,
      },
      {
        id: 1,
        reporter: OTHER,
        dead_url: "http://mirror-me.example.net/report-2018",
        snapshot_url: "https://web.archive.org/web/20180811090000/http://mirror-me.example.net/report-2018",
        snapshot_date: "2018-08-11",
        context: "The 2018 survey found that 61% of maintainers had considered quitting.",
        facets: ["The survey was run in 2018", "61% of maintainers had considered quitting"],
        evidence: { dead: "DEAD_SOFT", levels: ["YES", "YES"] },
        status: "OPEN",
        opened_on: "2026-10-05",
        replacement_url: "",
        proposals: [proposal("https://blog.example.org/maintainer-survey-recap", "DIFFERENT_SOURCE", ["YES", "PARTIAL"], "PARTIAL_SUPPORT", 7500)],
        winner: 0,
      },
      {
        id: 2,
        reporter: OTHER,
        dead_url: "https://startup-docs.example.io/api/v1/rate-limits",
        snapshot_url: "https://web.archive.org/web/20211004101500/https://startup-docs.example.io/api/v1/rate-limits",
        snapshot_date: "2021-10-04",
        context: "Requests are limited to 100 per minute per key.",
        facets: ["The limit is 100 requests per minute", "The limit applies per API key"],
        evidence: { dead: "DEAD_HTTP", levels: ["YES", "YES"] },
        status: "HEALED",
        opened_on: "2026-10-02",
        replacement_url: "https://docs.startup.example.io/api/rate-limits",
        proposals: [proposal("https://docs.startup.example.io/api/rate-limits", "SAME_DOCUMENT", ["YES", "YES"], "HEALED_SAME_DOCUMENT", 10000)],
        winner: 1,
      },
    ],
    lastReport: {},
    healedBy: { [OTHER]: 2 },
  };
}

let db = null;
function load() {
  if (db) return db;
  try {
    db = JSON.parse(localStorage.getItem(DB_KEY));
  } catch {
    db = null;
  }
  if (!db) {
    db = seed();
    save();
  }
  return db;
}
const save = () => localStorage.setItem(DB_KEY, JSON.stringify(db));

export function loadOrCreatePrivateKey() {
  return "0x" + "22".repeat(32);
}
export const newPrivateKey = loadOrCreatePrivateKey;
export const replacePrivateKey = (pk) => pk;
export const describeError = (err) => String(err?.message || err);

export async function connect({ network }) {
  load();
  return { client: { chain: {}, network }, address: DEMO_ADDRESS, mode: "local" };
}

const pub = (c, full) => ({
  id: c.id,
  dead_url: c.dead_url,
  snapshot_url: c.snapshot_url,
  snapshot_date: c.snapshot_date,
  status: c.status,
  opened_on: c.opened_on,
  reporter: c.reporter,
  replacement_url: c.replacement_url,
  facets: c.facets,
  proposal_count: c.proposals.length,
  winning_verdict: c.winner > 0 ? c.proposals[c.winner - 1].verdict : "",
  ...(full ? { context: c.context, evidence: c.evidence, proposals: c.proposals } : {}),
});

export async function read(_client, _address, fn, args = []) {
  load();
  await sleep(90);
  switch (fn) {
    case "get_count":
      return db.cases.length;
    case "get_case": {
      const c = db.cases[args[0]];
      if (!c) throw new Error("unknown case");
      return pub(c, true);
    }
    case "list_cases": {
      const [offset, limit] = args;
      return [...db.cases].reverse().slice(offset, offset + limit).map((c) => pub(c, false));
    }
    case "lookup":
      return db.cases.filter((c) => normalizeUrl(c.dead_url) === normalizeUrl(args[0])).map((c) => pub(c, false));
    case "get_finder":
      return { healed: db.healedBy[String(args[0]).toLowerCase()] || 0 };
    case "get_last_report":
      return db.lastReport[String(args[0]).toLowerCase()] || {};
    case "normalize":
      return normalizeUrl(args[0]);
    default:
      throw new Error(`demo chain: unsupported read ${fn}`);
  }
}

const userError = (m) => Object.assign(new Error(`The contract rejected this: ${m}`), { userError: true });
const today = () => new Date().toISOString().slice(0, 10);

function execute(fn, args) {
  if (fn === "open_case") {
    const [deadUrl, snapshotUrl, context, facets] = args;
    const key = normalizeUrl(deadUrl) + "|" + [...facets].map((f) => f.trim().toLowerCase()).sort().join("|");
    if (db.cases.some((c) => normalizeUrl(c.dead_url) + "|" + [...c.facets].map((f) => f.trim().toLowerCase()).sort().join("|") === key)) {
      throw userError("a case for this page and these facts already exists");
    }
    const alive = /alive/i.test(deadUrl);
    const unsupported = facets.some((f) => /false/i.test(f));
    const evidence = { dead: alive ? "ALIVE" : "DEAD_HTTP", levels: facets.map((f) => (/false/i.test(f) ? "NO" : "YES")) };
    if (alive || unsupported) {
      const reason = alive ? "LINK_IS_ALIVE" : "SNAPSHOT_DOES_NOT_SUPPORT_THE_FACTS";
      db.lastReport[DEMO_ADDRESS] = { dead_url: deadUrl, accepted: false, reason, evidence };
      return;
    }
    const m = /\/web\/(\d{4})(\d{2})(\d{2})/.exec(snapshotUrl);
    const id = db.cases.length;
    db.cases.push({
      id, reporter: DEMO_ADDRESS, dead_url: deadUrl, snapshot_url: snapshotUrl,
      snapshot_date: m ? `${m[1]}-${m[2]}-${m[3]}` : "unknown", context, facets, evidence,
      status: "OPEN", opened_on: today(), replacement_url: "", proposals: [], winner: 0,
    });
    db.lastReport[DEMO_ADDRESS] = { dead_url: deadUrl, accepted: true, case_id: id, evidence };
  } else if (fn === "propose") {
    const [id, url] = args;
    const c = db.cases[id];
    if (!c) throw userError("unknown case");
    if (c.status !== "OPEN") throw userError("this case is already healed");
    if (c.proposals.some((p) => normalizeUrl(p.url) === normalizeUrl(url))) throw userError("this replacement was already proposed");
    if (normalizeUrl(url) === normalizeUrl(c.dead_url)) throw userError("the replacement must differ from the dead URL");
    if (/archive\.(org|ph|is|today)/i.test(url)) throw userError("the archive snapshot is already the fallback; propose a live page");
    const n = c.facets.length;
    const kind = /same/i.test(url) ? "same" : /other/i.test(url) ? "other" : /weak/i.test(url) ? "weak" : "none";
    const relation = { same: "SAME_DOCUMENT", other: "DIFFERENT_SOURCE", weak: "DIFFERENT_SOURCE", none: "UNRELATED" }[kind];
    const levels = kind === "weak" ? c.facets.map((_, i) => (i === 0 ? "YES" : "PARTIAL")) : levelsOf(n, kind === "none" ? "NO" : "YES");
    const bps = Math.floor((levels.reduce((s, l) => s + (l === "YES" ? 2 : l === "PARTIAL" ? 1 : 0), 0) * 10000) / (2 * n));
    const verdict = kind === "none" ? "REJECTED" : bps === 10000 ? (relation === "SAME_DOCUMENT" ? "HEALED_SAME_DOCUMENT" : "HEALED_INDEPENDENT_SOURCE") : bps >= 5000 ? "PARTIAL_SUPPORT" : "REJECTED";
    c.proposals.push({ url, finder: DEMO_ADDRESS, relation, levels, verdict, fidelity_bps: bps, proposed_on: today() });
    if (verdict.startsWith("HEALED")) {
      c.status = "HEALED";
      c.replacement_url = url;
      c.winner = c.proposals.length;
      if (c.reporter !== DEMO_ADDRESS) db.healedBy[DEMO_ADDRESS] = (db.healedBy[DEMO_ADDRESS] || 0) + 1;
    }
  } else {
    throw userError(`unknown method ${fn}`);
  }
  save();
}

export async function sendTx({ functionName, args, onUpdate }) {
  load();
  onUpdate({ phase: "signing" });
  await sleep(350);
  const hash = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  onUpdate({ phase: "submitted", hash });
  for (const status of ["PENDING", "PROPOSING", "COMMITTING", "REVEALING"]) {
    await sleep(500);
    onUpdate({ phase: "consensus", status, hash });
  }
  await sleep(400);
  try {
    execute(functionName, args);
  } catch (err) {
    onUpdate({ phase: "failed", hash, message: err.message });
    throw err;
  }
  onUpdate({ phase: "accepted", status: "ACCEPTED", hash });
  setTimeout(() => onUpdate({ phase: "finalized", status: "FINALIZED", hash }), 3000);
  return { hash, tx: { statusName: "ACCEPTED" } };
}

export function resetDemo() {
  localStorage.removeItem(DB_KEY);
  db = null;
}
