import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeUrl,
  parseSnapshotUrl,
  snapshotFromAvailability,
  extractLinks,
  uniqueLinks,
  sentenceAround,
  applyRepairs,
  isArchiveHost,
  hostOf,
} from "../src/urls.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "..", "..", "tests", "vectors.json"), "utf8"));

for (const v of vectors.normalize) {
  test(`normalize parity: ${v.input}`, () => assert.equal(normalizeUrl(v.input), v.expected));
}
for (const v of vectors.snapshot) {
  test(`snapshot parity: ${v.snapshot.slice(28, 80)}`, () => assert.deepEqual(parseSnapshotUrl(v.snapshot, v.dead), v.expected));
}

test("hostOf and archive hosts", () => {
  assert.equal(hostOf("https://www.Example.com:8080/x?y=1"), "example.com");
  assert.ok(isArchiveHost("https://web.archive.org/web/2019/https://x.com"));
  assert.ok(isArchiveHost("https://sub.archive.org/x"));
  assert.ok(!isArchiveHost("https://notarchive.org/x"));
});

test("availability API response becomes a validated https snapshot", () => {
  const ok = {
    archived_snapshots: {
      closest: { available: true, status: "200", url: "http://web.archive.org/web/20190302123456/https://example.com/post", timestamp: "20190302123456" },
    },
  };
  assert.equal(snapshotFromAvailability(ok, "https://example.com/post"), "https://web.archive.org/web/20190302123456/https://example.com/post");
  assert.equal(snapshotFromAvailability({ archived_snapshots: {} }, "https://example.com/post"), null);
  const wrongPage = structuredClone(ok);
  assert.equal(snapshotFromAvailability(wrongPage, "https://example.com/other"), null);
  const redirectSnap = structuredClone(ok);
  redirectSnap.archived_snapshots.closest.status = "404";
  assert.equal(snapshotFromAvailability(redirectSnap, "https://example.com/post"), null);
});

test("extractLinks finds links in markdown, html and prose without trailing punctuation", () => {
  const text = `See [the study](https://a.example.com/study_(2019)) and <a href="https://b.example.org/x?y=1">this</a>.
Also https://c.example.net/page, and (https://d.example.io/p).`;
  const urls = extractLinks(text).map((l) => l.url);
  assert.deepEqual(urls, ["https://a.example.com/study_(2019)", "https://b.example.org/x?y=1", "https://c.example.net/page", "https://d.example.io/p"]);
});

test("extractLinks ignores things that are not links", () => {
  assert.deepEqual(extractLinks("http:// nothing, https://localhost and ftp://x.org/y"), []);
});

test("uniqueLinks groups URL variants", () => {
  const links = extractLinks("https://example.com/a and http://www.example.com/a/ and https://example.com/b");
  const u = uniqueLinks(links);
  assert.equal(u.length, 2);
  assert.equal(u.find((x) => x.key === "example.com/a").count, 2);
});

test("sentenceAround returns the citing sentence without link syntax", () => {
  const text = "Intro here. Sleep debt accumulates over a week, per [Smith 2019](https://example.com/smith) in a large cohort. Next sentence.";
  const i = text.indexOf("https://example.com/smith");
  assert.equal(sentenceAround(text, i), "Sleep debt accumulates over a week, per Smith 2019 in a large cohort.");
});

test("sentenceAround is bounded", () => {
  const text = "word ".repeat(300) + "https://example.com/x";
  assert.ok(sentenceAround(text, text.indexOf("https")).length <= 400);
});

test("applyRepairs rewrites every occurrence and nothing else", () => {
  const text = "A https://example.com/old and again (http://www.example.com/old/) but not https://example.com/keep.";
  const repairs = new Map([["example.com/old", "https://new.example.org/moved"]]);
  const { text: out, count } = applyRepairs(text, repairs);
  assert.equal(count, 2);
  assert.equal(out, "A https://new.example.org/moved and again (https://new.example.org/moved) but not https://example.com/keep.");
});

test("applyRepairs with no matches leaves the text untouched", () => {
  const { text, count } = applyRepairs("nothing https://example.com/x", new Map());
  assert.equal(count, 0);
  assert.equal(text, "nothing https://example.com/x");
});
