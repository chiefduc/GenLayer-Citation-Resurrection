import "./style.css";
import { NETWORKS, connect, read, sendTx, describeError, loadOrCreatePrivateKey, newPrivateKey, replacePrivateKey } from "./chain.js";
import {
  normalizeUrl,
  parseSnapshotUrl,
  snapshotFromAvailability,
  availabilityApi,
  waybackSearchPage,
  extractLinks,
  uniqueLinks,
  sentenceAround,
  applyRepairs,
  isArchiveHost,
} from "./urls.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// A String subclass marks markup that is already safe, so html`` results can be
// nested inside other html`` templates without being escaped twice.
class Raw extends String {}
const raw = (s) => new Raw(s);
const html = (strings, ...vals) =>
  raw(
    strings.reduce((out, str, i) => {
      const v = vals[i - 1];
      const piece = v instanceof Raw ? String(v) : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? String(x) : esc(x))).join("") : esc(v);
      return out + piece + str;
    }),
  );
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage can be blocked */
    }
  },
};
const short = (s, n = 6) => (s && s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s || "");
const fmtDate = (d) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d || "" : t.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
};
const trimUrl = (u, n = 64) => (u.length > n ? u.slice(0, n - 1) + "…" : u);

const VERDICTS = {
  HEALED_SAME_DOCUMENT: { label: "Same document, new address", cls: "healed" },
  HEALED_INDEPENDENT_SOURCE: { label: "Independent source states the same facts", cls: "healed" },
  PARTIAL_SUPPORT: { label: "Partial support", cls: "partial" },
  REJECTED: { label: "Rejected", cls: "neutral" },
};
const verdictOf = (v) => VERDICTS[v] || { label: v, cls: "neutral" };
const RELATIONS = { SAME_DOCUMENT: "Same document", DIFFERENT_SOURCE: "Different source", UNRELATED: "Unrelated" };
const DEAD_TEXT = {
  DEAD_HTTP: "The address could not be loaded.",
  DEAD_SOFT: "The address loads, but not the original page.",
  ALIVE: "The address still serves the original page.",
};
const REJECT_TEXT = {
  LINK_IS_ALIVE: "Validators found the original page still alive at this address, so there is nothing to resurrect.",
  SNAPSHOT_DOES_NOT_SUPPORT_THE_FACTS:
    "The archived snapshot does not clearly state every fact you listed, so no case was opened. Reword the facts to match what the page said, or pick a different snapshot.",
};

const SAMPLE = `Sleep debt accumulates over a week, and weekend recovery does not fully reverse it
([original study](https://old-blog.example.com/sleep-debt-study)).

The 2018 survey found that 61% of maintainers had considered quitting: http://mirror-me.example.net/report-2018.

Requests are limited to 100 per minute per key, see https://startup-docs.example.io/api/v1/rate-limits.
Background reading is at https://example.com/ and a vendor page that vanished: https://gone-vendor.example.co/whitepaper-2020.`;

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const DEMO = import.meta.env.MODE === "demo";
const state = {
  tab: "heal",
  network: store.get("cr.network") || import.meta.env.VITE_NETWORK || "studionet",
  contract: DEMO ? "0x" + "de".repeat(20) : store.get("cr.contract") || import.meta.env.VITE_CONTRACT_ADDRESS || "",
  mode: store.get("cr.mode") || "local",
  conn: null,
  connError: "",
  doc: store.get("cr.doc") ?? (DEMO ? SAMPLE : ""),
  lookups: new Map(), // normalized url -> { status: "loading"|"done"|"error", cases: [] }
  showUnknown: false,
  cases: [],
  casesTotal: 0,
  casesLoading: false,
  casesError: "",
  selectedId: null,
  selected: null,
  report: { deadUrl: "", snapshotUrl: "", context: "", facets: [""], note: "", result: null },
  txs: [],
  busy: false,
};
const app = $("#app");
let txCounter = 0;

/* ------------------------------------------------------------------ */
/* transaction tray                                                    */
/* ------------------------------------------------------------------ */

function trackTx(title) {
  const tx = { id: ++txCounter, title, phase: "signing", status: "", hash: "", message: "" };
  state.txs.push(tx);
  renderTray();
  return (u) => {
    Object.assign(tx, u);
    renderTray();
    if (u.phase === "finalized") setTimeout(() => dismissTx(tx.id), 8000);
  };
}
function dismissTx(id) {
  state.txs = state.txs.filter((t) => t.id !== id);
  renderTray();
}
function txView(t) {
  const idx = { signing: 0, submitted: 1, consensus: 2, accepted: 3, finalized: 5 }[t.phase];
  const failedAt = t.failedAt ?? 0;
  const seg = (i) => {
    if (t.phase === "failed") return i < failedAt ? "done" : i === failedAt ? "fail" : "";
    if (i < idx) return "done";
    if (i === idx || (t.phase === "accepted" && i === 4)) return "live";
    return "";
  };
  const text = {
    signing: "Waiting for your signature",
    submitted: "Submitted. Waiting for validators",
    consensus: `Validators are ${String(t.status || "working").toLowerCase().replace(/_/g, " ")}`,
    accepted: "Accepted. Waiting for finality; you can keep using the app",
    finalized: "Finalized",
    failed: t.message,
  }[t.phase];
  const explorer = state.conn?.client?.chain?.blockExplorers?.default?.url;
  return html`<div class="tx" role="status">
    <div class="tx-head"><span class="tx-title">${t.title}</span><button class="tx-x" data-dismiss="${t.id}" aria-label="Dismiss">×</button></div>
    <ul class="steps" aria-hidden="true">${raw([0, 1, 2, 3, 4].map((i) => `<li class="${seg(i)}"></li>`).join(""))}</ul>
    <div class="tx-status ${t.phase === "failed" ? "fail" : ""}">${text}</div>
    ${t.hash ? raw(`<span class="tx-hash mono">${explorer ? `<a href="${esc(explorer)}/tx/${esc(t.hash)}" target="_blank" rel="noopener">${esc(short(t.hash, 8))}</a>` : esc(short(t.hash, 8))}</span>`) : ""}
  </div>`;
}
function renderTray() {
  let tray = $("#tray");
  if (!tray) {
    tray = document.createElement("div");
    tray.id = "tray";
    tray.className = "tray";
    tray.setAttribute("aria-live", "polite");
    document.body.appendChild(tray);
    tray.addEventListener("click", (e) => {
      const b = e.target.closest("[data-dismiss]");
      if (b) dismissTx(Number(b.dataset.dismiss));
    });
  }
  tray.innerHTML = state.txs.map(txView).join("");
}
async function runTx(title, functionName, args) {
  const update = trackTx(title);
  const stageOf = { signing: 0, submitted: 1, consensus: 2, accepted: 3, finalized: 5 };
  let current = 0;
  const onUpdate = (u) => {
    if (u.phase in stageOf) current = stageOf[u.phase];
    update(u.phase === "failed" ? { ...u, failedAt: current } : u);
  };
  return sendTx({ client: state.conn.client, address: state.contract, functionName, args, onUpdate });
}
const flash = (title, message) => trackTx(title)({ phase: "failed", failedAt: 0, message });

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

const ready = () => Boolean(state.conn && /^0x[0-9a-fA-F]{40}$/.test(state.contract));
const rd = (fn, args = []) => read(state.conn.client, state.contract, fn, args);

async function reconnect() {
  state.conn = null;
  state.connError = "";
  state.lookups.clear();
  renderBar();
  try {
    state.conn = await connect({ network: state.network, mode: state.mode });
  } catch (err) {
    state.connError = describeError(err);
  }
  renderBar();
  renderCurrent();
  if (state.tab === "heal") scanDocument();
  if (state.tab === "cases") refreshCases(true);
}

async function refreshCases(reset = false) {
  if (!ready()) {
    state.cases = [];
    state.casesTotal = 0;
    return;
  }
  state.casesLoading = true;
  state.casesError = "";
  try {
    state.casesTotal = Number(await rd("get_count"));
    const offset = reset ? 0 : state.cases.length;
    const page = await rd("list_cases", [offset, 20]);
    state.cases = reset ? page : state.cases.concat(page);
  } catch (err) {
    state.casesError = describeError(err);
  }
  state.casesLoading = false;
  if (state.tab === "cases" && state.selectedId === null) renderCases();
}

async function loadCase(id) {
  state.selectedId = id;
  state.selected = null;
  renderCases();
  try {
    state.selected = await rd("get_case", [id]);
  } catch (err) {
    state.selected = { error: describeError(err) };
  }
  if (state.selectedId === id) renderCases();
}

/* ------------------------------------------------------------------ */
/* shell                                                               */
/* ------------------------------------------------------------------ */

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="var(--link)"/><path d="M10 22h18M36 22h18" stroke="var(--link-ink)" stroke-width="5" stroke-linecap="round" opacity=".45"/><path d="M10 42h44" stroke="var(--link-ink)" stroke-width="5" stroke-linecap="round"/><path d="M24 16v32M32 14v36M40 16v32" stroke="#7ee0b9" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="4 5.5"/></svg>`;

function renderShell() {
  app.innerHTML = html`<div class="shell"><header class="bar" id="bar"></header><main id="main"></main></div><dialog id="settings"></dialog>`;
  renderBar();
  $("#bar").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) switchTab(t.dataset.tab);
    if (e.target.closest("[data-open-settings]")) openSettings();
  });
}
function renderBar() {
  const bar = $("#bar");
  if (!bar) return;
  const acct = state.conn ? short(state.conn.address, 4) : state.connError ? "Not connected" : "Connecting…";
  const tabs = [
    ["heal", "Heal a document"],
    ["cases", "Cases"],
    ["report", "Report a dead link"],
  ];
  bar.innerHTML = html`
    <div class="brand">${raw(LOGO)}Citation Resurrection</div>
    <nav class="tabs" role="tablist" aria-label="Sections">${raw(tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${esc(l)}</button>`).join(""))}</nav>
    <div class="bar-end"><span class="muted small ui">${NETWORKS[state.network]?.label}</span>
      <button class="chip-btn" data-open-settings title="${state.connError || "Network, contract and key settings"}">${acct}</button></div>`;
}
function switchTab(tab) {
  state.tab = tab;
  if (tab === "cases") state.selectedId = null;
  renderBar();
  renderCurrent();
  if (tab === "heal") scanDocument();
  if (tab === "cases") refreshCases(true);
}
const renderCurrent = () => ({ heal: renderHeal, cases: renderCases, report: renderReport })[state.tab]();

const setupNotice = () =>
  DEMO
    ? html`<p class="note">Demo mode: a simulated chain in your browser with fake validators. A link counts as dead unless its address contains "alive". A snapshot supports every fact unless a fact contains "false". A replacement containing "same" is the same document, "other" an independent source, "weak" partial support.</p>`
    : !state.contract
      ? html`<p class="note warn">No contract address is set. Open the settings (top right) and paste the address of your deployed CitationResurrection contract.</p>`
      : state.connError
        ? html`<p class="note warn">${state.connError}</p>`
        : "";

/* ------------------------------------------------------------------ */
/* tab: heal a document                                                */
/* ------------------------------------------------------------------ */

function renderHeal() {
  $("#main").innerHTML = html`
    <section class="hero">
      <h1>Mend the citations that rotted.</h1>
      <p class="lede">Paste a document. Links that validators have already verified a replacement for are patched in place, and every repair says what it was checked against.</p>
      ${setupNotice()}
    </section>
    <section class="bench" aria-label="Document workbench">
      <div>
        <div class="pane-head"><h2>Your document</h2><span class="muted small ui" id="doc-meta"></span></div>
        <textarea id="doc" spellcheck="false" aria-label="Your document" placeholder="Paste markdown, HTML or plain text containing links.">${state.doc}</textarea>
        <div class="bench-actions"><button class="btn ghost small" id="sample" type="button">Try a sample</button></div>
      </div>
      <div>
        <div class="pane-head"><h2>Patched</h2><span class="muted small ui" id="patch-meta"></span></div>
        <div class="patched" id="patched" aria-live="polite"></div>
        <div class="bench-actions"><button class="btn" id="copy-patched" type="button" disabled>Copy patched text</button></div>
      </div>
    </section>
    <section class="section" aria-labelledby="links-h">
      <header><h2 id="links-h">Links in this document</h2><span class="muted small ui" id="links-summary"></span></header>
      <div id="links"></div>
    </section>`;
  $("#doc").addEventListener("input", (e) => {
    state.doc = e.target.value;
    store.set("cr.doc", state.doc);
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanDocument, 450);
    renderHealResults();
  });
  $("#sample").addEventListener("click", () => {
    state.doc = SAMPLE;
    store.set("cr.doc", state.doc);
    $("#doc").value = SAMPLE;
    scanDocument();
  });
  $("#copy-patched").addEventListener("click", async () => {
    const { text } = applyRepairs(state.doc, repairMap());
    await navigator.clipboard?.writeText(text);
    const b = $("#copy-patched");
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy patched text"), 1500);
  });
  renderHealResults();
}

let scanTimer = 0;
async function scanDocument() {
  if (state.tab !== "heal" || !ready()) return renderHealResults();
  const links = uniqueLinks(extractLinks(state.doc)).slice(0, 60);
  const todo = links.filter((l) => !state.lookups.has(l.key));
  for (const l of todo) state.lookups.set(l.key, { status: "loading", cases: [] });
  renderHealResults();
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const l = queue.shift();
      try {
        state.lookups.set(l.key, { status: "done", cases: await rd("lookup", [l.url]) });
      } catch {
        state.lookups.set(l.key, { status: "error", cases: [] });
      }
      renderHealResults();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// The healed case chosen for a URL (first healed; others are listed in the table).
const healedFor = (key) => state.lookups.get(key)?.cases.find((c) => c.status === "HEALED");
const openFor = (key) => state.lookups.get(key)?.cases.find((c) => c.status === "OPEN");
function repairMap() {
  const m = new Map();
  for (const [key, v] of state.lookups) {
    const h = v.cases.find((c) => c.status === "HEALED");
    if (h) m.set(key, h.replacement_url);
  }
  return m;
}

function renderHealResults() {
  const patched = $("#patched");
  if (!patched) return;
  const links = extractLinks(state.doc);
  const unique = uniqueLinks(links);

  // patched pane: the document, with mended links shown as old struck through, new stitched in
  let out = "";
  let cursor = 0;
  for (const l of links) {
    out += esc(state.doc.slice(cursor, l.index));
    const key = normalizeUrl(l.url);
    const h = healedFor(key);
    const o = openFor(key);
    const loading = state.lookups.get(key)?.status === "loading";
    if (h) out += `<span class="mend"><del>${esc(l.url)}</del> <ins>${esc(h.replacement_url)}</ins></span>`;
    else if (o) out += `<span class="waiting" title="A case is open and waiting for a replacement">${esc(l.url)}</span>`;
    else if (loading) out += `<span class="checking">${esc(l.url)}</span>`;
    else out += esc(l.url);
    cursor = l.end;
  }
  out += esc(state.doc.slice(cursor));
  patched.innerHTML = state.doc.trim() ? out : `<span class="empty">The patched document appears here.</span>`;

  const mended = unique.filter((u) => healedFor(u.key));
  const waiting = unique.filter((u) => !healedFor(u.key) && openFor(u.key));
  const unknown = unique.filter((u) => !healedFor(u.key) && !openFor(u.key));
  const checking = unique.filter((u) => state.lookups.get(u.key)?.status === "loading").length;
  const { count } = applyRepairs(state.doc, repairMap());
  $("#copy-patched").disabled = count === 0;
  $("#patch-meta").textContent = count ? `${count} link${count === 1 ? "" : "s"} mended` : "";
  $("#doc-meta").textContent = unique.length ? `${unique.length} link${unique.length === 1 ? "" : "s"}` : "";
  $("#links-summary").textContent = !unique.length
    ? ""
    : !ready()
      ? "Connect to look these up."
      : checking
        ? `Checking ${checking} of ${unique.length}…`
        : `${mended.length} mended, ${waiting.length} waiting for a replacement, ${unknown.length} not in the registry`;

  const row = (u) => {
    const h = healedFor(u.key);
    const o = openFor(u.key);
    const c = h || o;
    const extra = state.lookups.get(u.key).cases.length - 1;
    return `<div class="row"><div>
        <div class="seam ${h ? "" : "open"}"><span class="mono from">${esc(trimUrl(u.url))}</span><span class="stitch" aria-hidden="true"></span>
          ${h ? `<a class="mono to" href="${esc(h.replacement_url)}" target="_blank" rel="noopener noreferrer">${esc(trimUrl(h.replacement_url))}</a>` : `<span class="to none">Waiting for a replacement</span>`}</div>
        <div class="row-meta">For: ${esc(c.facets.join("; "))}${extra > 0 ? ` (this link has ${extra} more case${extra > 1 ? "s" : ""})` : ""}</div></div>
      <div class="row-actions">${h ? `<span class="chip healed">${esc(verdictOf(h.winning_verdict).label)}</span>` : `<span class="chip open">Open case</span>`}
        <button class="btn ghost small" data-case="${c.id}" type="button">View case</button></div></div>`;
  };
  const unknownRows = unknown
    .filter((u) => state.lookups.get(u.key)?.status === "done")
    .map(
      (u) => `<div class="row"><div><span class="mono">${esc(trimUrl(u.url, 80))}</span></div>
      <div class="row-actions"><button class="btn ghost small" data-report="${esc(u.url)}" data-at="${u.index}" type="button">Report as dead</button></div></div>`,
    );
  const rows = [...mended, ...waiting].map(row).join("");
  $("#links").innerHTML = !unique.length
    ? `<p class="empty-row">No links yet. Paste a document above, or try the sample.</p>`
    : `${rows ? `<div class="rows">${rows}</div>` : ready() && !checking ? `<p class="empty-row">None of these links have a case yet.</p>` : ""}
       ${unknownRows.length ? `<p style="margin-top:14px"><button class="btn ghost small" id="toggle-unknown" type="button">${state.showUnknown ? "Hide" : "Show"} the ${unknownRows.length} not in the registry</button></p>${state.showUnknown ? `<div class="rows">${unknownRows.join("")}</div>` : ""}` : ""}`;

  $("#toggle-unknown")?.addEventListener("click", () => {
    state.showUnknown = !state.showUnknown;
    renderHealResults();
  });
  $$("[data-case]", $("#links")).forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = "cases";
      renderBar();
      loadCase(Number(b.dataset.case));
    }),
  );
  $$("[data-report]", $("#links")).forEach((b) =>
    b.addEventListener("click", () => {
      const at = Number(b.dataset.at);
      state.report = { deadUrl: b.dataset.report, snapshotUrl: "", context: sentenceAround(state.doc, at), facets: [""], note: "", result: null };
      state.tab = "report";
      renderBar();
      renderReport();
    }),
  );
}

/* ------------------------------------------------------------------ */
/* tab: cases                                                          */
/* ------------------------------------------------------------------ */

const seam = (c) => `<div class="seam ${c.status === "HEALED" ? "" : "open"}"><span class="mono from">${esc(trimUrl(c.dead_url, 56))}</span><span class="stitch" aria-hidden="true"></span>
  ${c.status === "HEALED" ? `<span class="mono to">${esc(trimUrl(c.replacement_url, 56))}</span>` : `<span class="to none">Waiting for a replacement</span>`}</div>`;

function renderCases() {
  const main = $("#main");
  if (state.selectedId !== null) return renderCase(main);
  const rows = state.cases
    .map(
      (c) => `<div class="row clickable" data-open="${c.id}" tabindex="0" role="link" aria-label="Open case ${c.id}"><div>
        ${seam(c)}<div class="row-meta">Case #${c.id}, opened ${esc(fmtDate(c.opened_on))}. For: ${esc(c.facets.join("; "))}</div></div>
      <div class="row-actions">${c.proposal_count ? `<span class="chip neutral">${c.proposal_count} proposed</span>` : ""}
        ${c.status === "HEALED" ? `<span class="chip healed">Healed</span>` : `<span class="chip open">Open</span>`}</div></div>`,
    )
    .join("");
  main.innerHTML = html`<section class="section">
    <header><h2>Cases</h2><span class="muted small ui">${state.casesTotal} total, newest first</span><button class="btn ghost small" id="reload" type="button">Refresh</button></header>
    ${setupNotice()}
    <div class="rows">${raw(rows)}</div>
    ${state.cases.length === 0 ? raw(`<p class="empty-row">${state.casesLoading ? "Loading…" : esc(state.casesError) || "No cases yet. Report the first dead link."}</p>`) : ""}
    ${state.cases.length < state.casesTotal ? raw(`<p style="margin-top:16px"><button class="btn ghost" id="more" type="button">Load more</button></p>`) : ""}
  </section>`;
  $("#reload")?.addEventListener("click", () => refreshCases(true));
  $("#more")?.addEventListener("click", () => refreshCases(false));
  $$("[data-open]", main).forEach((r) => {
    const open = () => loadCase(Number(r.dataset.open));
    r.addEventListener("click", open);
    r.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
  });
}

const levelCell = (lv) => `<td class="lv ${lv === "YES" ? "yes" : lv === "PARTIAL" ? "partial" : "no"}">${lv === "YES" ? "Yes" : lv === "PARTIAL" ? "Partial" : "No"}</td>`;

function renderCase(main) {
  const c = state.selected;
  const back = `<button class="back" id="back" type="button">Back to cases</button>`;
  if (!c) {
    main.innerHTML = `${back}<p class="empty-row">Loading case…</p>`;
  } else if (c.error) {
    main.innerHTML = `${back}<p class="empty-row">${esc(c.error)}</p>`;
  } else {
    const healed = c.status === "HEALED";
    const winIdx = c.proposals.findIndex((p) => healed && p.url === c.replacement_url);
    const head = c.proposals.map((p, i) => `<th scope="col" class="${i === winIdx ? "win" : ""}">Proposal ${i + 1}</th>`).join("");
    const body = c.facets
      .map(
        (f, fi) => `<tr><th scope="row">${esc(f)}</th>${levelCell(c.evidence.levels[fi])}${c.proposals.map((p, i) => levelCell(p.levels[fi]).replace("<td", `<td${i === winIdx ? ' data-win="1"' : ""}`)).join("")}</tr>`,
      )
      .join("");
    main.innerHTML = `${back}
    <section class="case-head stack">
      <div><h2>Case #${c.id} ${healed ? `<span class="chip healed">Healed</span>` : `<span class="chip open">Open</span>`}</h2>${seam(c)}</div>
      <div><h3>What the citation was used for</h3><p class="quote">${esc(c.context)}</p></div>
      <div><h3>Reference snapshot</h3>
        <p class="small">Captured ${esc(fmtDate(c.snapshot_date))}: <a class="mono" href="${esc(c.snapshot_url)}" target="_blank" rel="noopener noreferrer">${esc(trimUrl(c.snapshot_url, 90))}</a><br />
        <span class="muted">${esc(DEAD_TEXT[c.evidence.dead] || "")} Reported by <span class="mono">${esc(short(c.reporter, 4))}</span> on ${esc(fmtDate(c.opened_on))}.</span></p></div>
      <div><h3>Facts a replacement must state</h3>
        <table class="matrix"><thead><tr><th scope="col">Fact</th><th scope="col">Original snapshot</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div><h3>Proposals</h3>
        ${c.proposals.length ? c.proposals.map((p, i) => {
          const v = verdictOf(p.verdict);
          return `<div class="proposal"><div class="proposal-head"><span class="chip ${v.cls}">${esc(v.label)}</span><span class="muted small ui">Proposal ${i + 1}: ${esc(RELATIONS[p.relation] || p.relation)}, ${Math.round(p.fidelity_bps / 100)}% of facts, by ${esc(short(p.finder, 4))} on ${esc(fmtDate(p.proposed_on))}</span></div>
            <p class="small"><a class="mono" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a></p></div>`;
        }).join("") : `<p class="muted">Nothing proposed yet.</p>`}
      </div>
      ${healed ? "" : `<form id="propose-form" class="stack">
        <div><label class="field" for="rep-url">Propose a replacement <span class="hint">A live https page. Validators read it, compare it with the snapshot, and check it states every fact above. The first proposal that does so heals the case.</span></label>
          <div class="inline"><input id="rep-url" class="url" type="url" inputmode="url" placeholder="https://" autocomplete="off" /><button class="btn" type="submit" ${ready() ? "" : "disabled"}>Propose replacement</button></div>
          <p class="problem" id="rep-problem" role="alert"></p></div></form>`}
    </section>`;
    $$("td[data-win]", main).forEach((td) => td.classList.add("win"));
    $("#propose-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = $("#rep-url").value.trim();
      const problem = !/^https:\/\/\S+\.\S+$/.test(url) ? "Enter a full https address." : isArchiveHost(url) ? "The archive snapshot is already the fallback. Propose a live page." : normalizeUrl(url) === normalizeUrl(c.dead_url) ? "That is the dead address itself." : "";
      $("#rep-problem").textContent = problem;
      if (problem || state.busy) return;
      state.busy = true;
      try {
        await runTx("Propose replacement", "propose", [c.id, url]);
        state.selected = await rd("get_case", [c.id]);
        refreshCases(true);
        state.lookups.clear();
      } catch {
        /* the tray says why */
      } finally {
        state.busy = false;
        if (state.tab === "cases" && state.selectedId === c.id) renderCases();
      }
    });
  }
  $("#back").addEventListener("click", () => {
    state.selectedId = null;
    state.selected = null;
    renderCases();
  });
}

/* ------------------------------------------------------------------ */
/* tab: report a dead link                                             */
/* ------------------------------------------------------------------ */

function reportProblem() {
  const r = state.report;
  if (!/^https?:\/\/\S+\.\S+$/.test(r.deadUrl.trim())) return "Enter the full address of the dead page.";
  if (isArchiveHost(r.deadUrl.trim())) return "Report the original page, not an archive copy.";
  if (!parseSnapshotUrl(r.snapshotUrl.trim(), r.deadUrl.trim())) return "Add an Internet Archive snapshot of exactly this page.";
  if (!r.context.trim()) return "Say what the citation was used for.";
  if (r.context.length > 400) return "The citing sentence is over 400 characters.";
  const f = r.facets.map((x) => x.trim());
  if (f.some((x) => !x)) return "Fill in every fact, or remove the empty ones.";
  if (new Set(f.map((x) => x.toLowerCase())).size !== f.length) return "Two facts are the same.";
  if (f.some((x) => x.length > 200)) return "A fact is over 200 characters.";
  return "";
}

function renderReport() {
  const r = state.report;
  $("#main").innerHTML = html`<section class="formgrid">
    <form id="report-form" class="stack" novalidate>
      <div><h1 style="font-size:2rem">Report a dead link</h1>
        <p class="muted" style="margin-top:10px">Validators check that the link really is dead, that the snapshot really is that page, and that the page really stated each fact. Then anyone can propose a replacement.</p></div>
      ${setupNotice()}
      <div><label class="field" for="dead-url">Dead address</label>
        <input id="dead-url" class="url" type="url" inputmode="url" placeholder="https://" autocomplete="off" value="${r.deadUrl}" /></div>
      <div><label class="field" for="snap-url">Internet Archive snapshot <span class="hint">A capture of this page from when it still worked.</span></label>
        <div class="inline"><input id="snap-url" class="url" type="url" inputmode="url" placeholder="https://web.archive.org/web/…" autocomplete="off" value="${r.snapshotUrl}" />
          <button class="btn ghost" id="find-snap" type="button">Find snapshot</button></div>
        <p class="small" id="snap-note" role="status"></p></div>
      <div><label class="field" for="context">The citing sentence <span class="hint">How the document used this link.</span></label>
        <textarea id="context" rows="3" maxlength="400">${r.context}</textarea><div class="count" id="ctx-count"></div></div>
      <div><label class="field">Specific facts it supported <span class="hint">One to four statements a replacement must also state. Specific beats broad: "The limit is 100 requests per minute", not "rate limits".</span></label>
        <div id="facets"></div><button class="btn ghost small" id="add-facet" type="button">Add fact</button></div>
      <div><button class="btn" id="open-case" type="submit">Open case</button><p class="problem" id="report-problem" role="alert"></p></div>
      <div id="report-result"></div>
    </form>
    <aside class="small muted">
      <h3 class="ui" style="margin-bottom:8px;color:var(--ink)">What happens next</h3>
      <p>Validators load the snapshot and the live address. If the page is still alive, or the snapshot does not clearly state every fact, no case is opened and you are told why.</p>
      <p>Otherwise the case opens and anyone can propose a replacement. The first one that states every fact heals it, and the repair becomes visible to every document that cites the old address.</p>
    </aside>
  </section>`;
  renderFacets();
  syncReport();
  renderReportResult();
  const form = $("#report-form");
  $("#dead-url").addEventListener("input", (e) => {
    r.deadUrl = e.target.value;
    syncReport();
  });
  $("#snap-url").addEventListener("input", (e) => {
    r.snapshotUrl = e.target.value;
    syncReport();
  });
  $("#context").addEventListener("input", (e) => {
    r.context = e.target.value;
    syncReport();
  });
  $("#facets").addEventListener("input", (e) => {
    const i = e.target.dataset.f;
    if (i !== undefined) {
      r.facets[Number(i)] = e.target.value;
      syncReport();
    }
  });
  $("#facets").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      r.facets.splice(Number(rm.dataset.rm), 1);
      renderFacets();
      syncReport();
    }
  });
  $("#add-facet").addEventListener("click", () => {
    if (r.facets.length < 4) {
      r.facets.push("");
      renderFacets();
      $$("#facets input").at(-1)?.focus();
      syncReport();
    }
  });
  $("#find-snap").addEventListener("click", findSnapshot);
  form.addEventListener("submit", submitReport);
}

function renderFacets() {
  const r = state.report;
  $("#facets").innerHTML = r.facets
    .map(
      (f, i) => `<div class="el-row"><input type="text" data-f="${i}" value="${esc(f)}" maxlength="200" aria-label="Fact ${i + 1}" placeholder="One specific, checkable statement" />
      ${r.facets.length > 1 ? `<button class="btn ghost small" type="button" data-rm="${i}" aria-label="Remove fact ${i + 1}">Remove</button>` : "<span></span>"}</div>`,
    )
    .join("");
  const add = $("#add-facet");
  if (add) add.disabled = r.facets.length >= 4;
}

function syncReport() {
  const r = state.report;
  const snap = r.snapshotUrl.trim() ? parseSnapshotUrl(r.snapshotUrl.trim(), r.deadUrl.trim()) : null;
  const note = $("#snap-note");
  if (note) {
    note.className = "small " + (snap ? "ok-line" : "muted");
    note.textContent = !r.snapshotUrl.trim() ? r.note : snap ? `Valid. Captured ${fmtDate(snap.timestamp.slice(0, 4) + "-" + snap.timestamp.slice(4, 6) + "-" + snap.timestamp.slice(6, 8))}.` : "This must be a web.archive.org snapshot of exactly this page.";
  }
  const cc = $("#ctx-count");
  if (cc) cc.textContent = `${r.context.length} / 400`;
  const btn = $("#open-case");
  if (btn) btn.disabled = state.busy || !ready() || Boolean(reportProblem());
}

async function findSnapshot() {
  const r = state.report;
  const url = r.deadUrl.trim();
  const note = $("#snap-note");
  if (!/^https?:\/\/\S+\.\S+$/.test(url)) {
    note.className = "small muted";
    note.textContent = "Enter the dead address first.";
    return;
  }
  note.className = "small muted";
  note.textContent = "Asking the Internet Archive…";
  try {
    const res = await fetch(availabilityApi(url));
    const snap = snapshotFromAvailability(await res.json(), url);
    if (snap) {
      r.snapshotUrl = snap;
      $("#snap-url").value = snap;
      syncReport();
      return;
    }
    r.note = "";
    note.innerHTML = `No usable snapshot found automatically. <a href="${esc(waybackSearchPage(url))}" target="_blank" rel="noopener noreferrer">Browse the archive's captures</a>, pick one from when the page worked, and paste its address.`;
  } catch {
    note.innerHTML = `Could not reach the Internet Archive from here. <a href="${esc(waybackSearchPage(url))}" target="_blank" rel="noopener noreferrer">Browse its captures</a> and paste one.`;
  }
}

async function submitReport(e) {
  e.preventDefault();
  const r = state.report;
  const problem = reportProblem();
  $("#report-problem").textContent = problem;
  if (problem || state.busy || !ready()) return;
  state.busy = true;
  syncReport();
  try {
    await runTx("Open case", "open_case", [r.deadUrl.trim(), r.snapshotUrl.trim(), r.context.trim(), r.facets.map((f) => f.trim())]);
    r.result = await rd("get_last_report", [state.conn.address]);
    state.lookups.clear();
    refreshCases(true);
  } catch (err) {
    $("#report-problem").textContent = err.message;
  } finally {
    state.busy = false;
    renderReportResult();
    syncReport();
  }
}

function renderReportResult() {
  const box = $("#report-result");
  const res = state.report.result;
  if (!box || !res || !res.dead_url) return (box.innerHTML = "");
  box.innerHTML = res.accepted
    ? `<div class="result good"><strong class="ui">Case #${res.case_id} is open.</strong><p style="margin:6px 0 10px">Validators confirmed the link is dead and the snapshot states every fact. Anyone can now propose a replacement.</p>
        <button class="btn small" type="button" id="view-case">View the case</button></div>`
    : `<div class="result bad"><strong class="ui">No case was opened.</strong><p style="margin:6px 0 0">${esc(REJECT_TEXT[res.reason] || res.reason)}</p></div>`;
  $("#view-case")?.addEventListener("click", () => {
    state.tab = "cases";
    renderBar();
    loadCase(res.case_id);
  });
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  const dlg = $("#settings");
  dlg.innerHTML = html`<form method="dialog" class="stack" id="settings-form">
    <h2>Settings</h2>
    <div><label class="field" for="s-net">Network</label>
      <select id="s-net">${raw(Object.entries(NETWORKS).map(([k, n]) => `<option value="${k}" ${k === state.network ? "selected" : ""}>${esc(n.label)}</option>`).join(""))}</select></div>
    <div><label class="field" for="s-addr">Contract address <span class="hint">The deployed CitationResurrection contract on this network.</span></label>
      <input id="s-addr" class="url" type="text" value="${state.contract}" placeholder="0x…" spellcheck="false" autocomplete="off" ${DEMO ? "disabled" : ""} /></div>
    <div><label class="field" for="s-mode">Signer</label>
      <select id="s-mode"><option value="local" ${state.mode === "local" ? "selected" : ""}>Key stored in this browser</option><option value="wallet" ${state.mode === "wallet" ? "selected" : ""}>Browser wallet (beta)</option></select>
      <p class="small muted" style="margin-top:8px">${state.conn ? raw(`Account <span class="mono">${esc(state.conn.address)}</span>`) : "Not connected"}</p>
      <p class="small muted">Testnets charge fees: fund this account from the network faucet first. Studio and local nodes are free.</p></div>
    <div id="key-tools" ${state.mode === "local" ? "" : "hidden"}>
      <button class="btn ghost small" type="button" id="key-copy">Copy private key</button>
      <button class="btn ghost small" type="button" id="key-new">New key</button>
      <button class="btn ghost small" type="button" id="key-import">Import key</button>
      <p class="toast-line muted" id="key-msg" role="status"></p></div>
    <div class="dialog-actions"><button class="btn" value="save">Save</button><button class="btn ghost" value="cancel">Cancel</button></div>
  </form>`;
  $("#s-mode").addEventListener("change", (e) => ($("#key-tools").hidden = e.target.value !== "local"));
  $("#key-copy").addEventListener("click", async () => {
    await navigator.clipboard?.writeText(loadOrCreatePrivateKey());
    $("#key-msg").textContent = "Private key copied. Anyone with it controls this account.";
  });
  $("#key-new").addEventListener("click", () => {
    if (confirm("Create a new key? Copy the current one first if you want to keep this account.")) {
      newPrivateKey();
      $("#key-msg").textContent = "New key created. Save to use it.";
    }
  });
  $("#key-import").addEventListener("click", () => {
    const pk = prompt("Paste a private key (0x followed by 64 hex characters)");
    if (!pk) return;
    try {
      replacePrivateKey(pk.trim());
      $("#key-msg").textContent = "Key imported. Save to use it.";
    } catch (err) {
      $("#key-msg").textContent = err.message;
    }
  });
  $("#settings-form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    state.network = $("#s-net").value;
    if (!DEMO) state.contract = $("#s-addr").value.trim();
    state.mode = $("#s-mode").value;
    store.set("cr.network", state.network);
    store.set("cr.contract", state.contract);
    store.set("cr.mode", state.mode);
    state.cases = [];
    reconnect();
  });
  dlg.showModal();
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

renderShell();
renderHeal();
reconnect();
void flash;
