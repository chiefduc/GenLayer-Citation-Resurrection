// Transaction lifecycle tests against a fake client (no network needed).
import test from "node:test";
import assert from "node:assert/strict";
import { sendTx, describeError, plain } from "../src/chain.js";

function fakeClient(statuses, { writeError, extra = {} } = {}) {
  let i = 0;
  return {
    async writeContract() {
      if (writeError) throw writeError;
      return "0x" + "ab".repeat(32);
    },
    async getTransaction() {
      const s = statuses[Math.min(i++, statuses.length - 1)];
      if (s instanceof Error) throw s;
      return { statusName: s, ...extra };
    },
  };
}
const run = (client, extra = {}) => {
  const updates = [];
  const p = sendTx({ client, address: "0x1", functionName: "commit", args: ["x"], onUpdate: (u) => updates.push(u), pollMs: 5, finalityTimeoutMs: 150, ...extra });
  return { p, updates };
};

test("reports signing, submitted, consensus stages, then accepted", async () => {
  const { p, updates } = run(fakeClient(["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED"]));
  const { hash } = await p;
  assert.equal(hash.length, 66);
  const phases = updates.map((u) => u.phase);
  assert.deepEqual(phases.slice(0, 2), ["signing", "submitted"]);
  assert.ok(phases.includes("consensus"));
  assert.equal(phases.at(-1), "accepted");
  assert.deepEqual(
    updates.filter((u) => u.phase === "consensus").map((u) => u.status),
    ["PENDING", "PROPOSING", "COMMITTING", "REVEALING"],
  );
});

test("keeps watching and reports finalized after accepted", async () => {
  const { p, updates } = run(fakeClient(["ACCEPTED", "ACCEPTED", "FINALIZED"]));
  await p;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(updates.at(-1).phase, "finalized");
});

test("a transaction already finalized resolves as finalized", async () => {
  const { p, updates } = run(fakeClient(["FINALIZED"]));
  await p;
  assert.equal(updates.at(-1).phase, "finalized");
});

test("UNDETERMINED fails with an explanation", async () => {
  const { p, updates } = run(fakeClient(["PENDING", "UNDETERMINED"]));
  await assert.rejects(p, /could not agree/);
  assert.equal(updates.at(-1).phase, "failed");
});

for (const s of ["CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]) {
  test(`${s} fails`, async () => {
    const { p } = run(fakeClient([s]));
    await assert.rejects(p);
  });
}

test("contract rejection is surfaced even though consensus accepted it", async () => {
  const client = fakeClient(["ACCEPTED"], {
    extra: {
      txExecutionResultName: "FINISHED_WITH_ERROR",
      consensus_data: { leader_receipt: [{ error: "UserError: reveal does not match the committed hash", result: "" }] },
    },
  });
  const { p, updates } = run(client);
  await assert.rejects(p, /reveal does not match the committed hash/);
  assert.equal(updates.at(-1).phase, "failed");
});

test("declined signature gives a clear message and no hash", async () => {
  const { p, updates } = run(fakeClient([], { writeError: new Error("User rejected the request.") }));
  await assert.rejects(p, /declined/);
  assert.equal(updates.at(-1).phase, "failed");
  assert.ok(!updates.some((u) => u.phase === "submitted"));
});

test("transient RPC errors while polling are retried", async () => {
  const { p } = run(fakeClient([new Error("socket hang up"), "PENDING", "ACCEPTED"]));
  const { tx } = await p;
  assert.equal(tx.statusName, "ACCEPTED");
});

test("times out with a message that says the tx may still complete", async () => {
  const { p } = run(fakeClient(["PENDING"]), { timeoutMs: 60 });
  await assert.rejects(p, /may still complete/);
});

test("describeError maps common failures", () => {
  assert.match(describeError(new Error("Failed to fetch")), /Could not reach/);
  assert.match(describeError(new Error("insufficient funds for gas * price + value: balance 0")), /no funds/);
});

test("plain converts Maps and bigints", () => {
  const out = plain(new Map([["a", 1n], ["b", [new Map([["c", 2n]])]]]));
  assert.deepEqual(out, { a: 1, b: [{ c: 2 }] });
});
