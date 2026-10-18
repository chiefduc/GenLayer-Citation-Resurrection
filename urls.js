// URL helpers. normalizeUrl and parseSnapshotUrl must agree with the contract's
// normalize_url / parse_snapshot_url; test/urls.test.mjs checks them against
// tests/vectors.json, which Python generates from the contract.

const SNAPSHOT_PREFIX = "https://web.archive.org/web/";
const ARCHIVE_HOSTS = ["web.archive.org", "archive.org", "archive.ph", "archive.is", "archive.today", "webcache.googleusercontent.com"];

export function normalizeUrl(url) {
  let u = url.trim().split("#")[0];
  const lower = u.toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (lower.startsWith(prefix)) {
      u = u.slice(prefix.length);
      break;
    }
  }
  const q = u.indexOf("?");
  const base = q === -1 ? u : u.slice(0, q);
  const query = q === -1 ? "" : u.slice(q);
  const slash = base.indexOf("/");
  let host = slash === -1 ? base : base.slice(0, slash);
  let path = slash === -1 ? "" : base.slice(slash);
  host = host.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.endsWith(":80") || host.endsWith(":443")) host = host.slice(0, host.lastIndexOf(":"));
  return host + path.replace(/\/+$/, "") + query;
}

export function hostOf(url) {
  return normalizeUrl(url).split("/")[0].split("?")[0].split(":")[0];
}

export function isArchiveHost(url) {
  const h = hostOf(url);
  return ARCHIVE_HOSTS.includes(h) || h.endsWith(".archive.org");
}

const isIsoDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
  return y >= 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
};

// Returns { timestamp, date } when snapshotUrl is a Wayback snapshot of exactly deadUrl, else null.
export function parseSnapshotUrl(snapshotUrl, deadUrl) {
  if (typeof snapshotUrl !== "string" || !snapshotUrl.startsWith(SNAPSHOT_PREFIX)) return null;
  const rest = snapshotUrl.slice(SNAPSHOT_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const stamp = rest.slice(0, slash);
  const original = rest.slice(slash + 1);
  const digits = stamp.slice(0, 14);
  const flags = stamp.slice(14);
  if (!/^\d{14}$/.test(digits)) return null;
  if (flags && !/^[A-Za-z]+_$/.test(flags)) return null;
  if (!original) return null;
  if (normalizeUrl(original) !== normalizeUrl(deadUrl)) return null;
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (!isIsoDate(date)) return null;
  return { timestamp: digits, date };
}

// The Internet Archive "availability" API answers with the closest snapshot.
export function snapshotFromAvailability(json, deadUrl) {
  const closest = json?.archived_snapshots?.closest;
  if (!closest?.available || String(closest.status) !== "200" || typeof closest.url !== "string") return null;
  const https = closest.url.replace(/^http:\/\//, "https://");
  return parseSnapshotUrl(https, deadUrl) ? https : null;
}

export const availabilityApi = (deadUrl) => `https://archive.org/wayback/available?url=${encodeURIComponent(deadUrl)}`;
export const waybackSearchPage = (deadUrl) => `https://web.archive.org/web/*/${deadUrl}`;

/* ------------------------------------------------------------------ */
/* documents                                                           */
/* ------------------------------------------------------------------ */

// Every http(s) link in markdown, HTML or plain text, with its position.
export function extractLinks(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"'`\]\[{}|\\^]+/g;
  let m;
  while ((m = re.exec(text))) {
    let url = m[0];
    // trailing punctuation belongs to the sentence, not the URL
    const count = (s, ch) => s.split(ch).length - 1;
    while (/[.,;:!?'"]$/.test(url) || (url.endsWith(")") && count(url, ")") > count(url, "("))) url = url.slice(0, -1);
    if (!/^https?:\/\/[^/.\s]+\.[^\s]+/.test(url)) continue;
    out.push({ url, index: m.index, end: m.index + url.length });
  }
  return out;
}

export function uniqueLinks(links) {
  const seen = new Map();
  for (const l of links) {
    const key = normalizeUrl(l.url);
    if (!seen.has(key)) seen.set(key, { url: l.url, key, index: l.index, count: 0 });
    seen.get(key).count += 1;
  }
  return [...seen.values()];
}

// The sentence a link sits in, cleaned of markdown link syntax, for use as citing context.
export function sentenceAround(text, index, max = 400) {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !/[!?\n]/.test(text[end]) && !(text[end] === "." && /\s/.test(text[end + 1] ?? " "))) end++;
  let s = text.slice(start, Math.min(end + 1, text.length));
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)]*)\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/<[^>]+>/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// repairs: Map<normalizedDeadUrl, replacementUrl>. Replaces every occurrence.
export function applyRepairs(text, repairs) {
  const links = extractLinks(text).filter((l) => repairs.has(normalizeUrl(l.url)));
  let out = text;
  for (const l of links.sort((a, b) => b.index - a.index)) {
    out = out.slice(0, l.index) + repairs.get(normalizeUrl(l.url)) + out.slice(l.end);
  }
  return { text: out, count: links.length };
}
