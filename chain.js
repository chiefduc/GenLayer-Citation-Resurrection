// GenLayer access layer: client creation, reads, and a transaction tracker
// that reports every stage of the lifecycle (sign, submit, consensus, accepted,
// finalized) and turns failures into messages a person can act on.
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet, localnet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

export const NETWORKS = {
  studionet: { label: "GenLayer Studio", chain: studionet },
  localnet: { label: "Local node", chain: localnet },
  testnetBradbury: { label: "Testnet Bradbury", chain: testnetBradbury },
  testnetAsimov: { label: "Testnet Asimov", chain: testnetAsimov },
};

const KEY_STORE = "pac.privateKey";

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked; the session still works */
  }
}

export function loadOrCreatePrivateKey() {
  let pk = safeGet(KEY_STORE);
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    pk = generatePrivateKey();
    safeSet(KEY_STORE, pk);
  }
  return pk;
}

export function replacePrivateKey(pk) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("A private key is 0x followed by 64 hex characters.");
  safeSet(KEY_STORE, pk);
  return pk;
}

export function newPrivateKey() {
  const pk = generatePrivateKey();
  safeSet(KEY_STORE, pk);
  return pk;
}

// mode "local": a key kept in this browser (best for Studio and testnets).
// mode "wallet": an injected browser wallet.
export async function connect({ network, mode }) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`Unknown network: ${network}`);

  if (mode === "wallet") {
    if (!window.ethereum) throw new Error("No browser wallet found. Use the in-browser key instead.");
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const client = createClient({ chain: net.chain, account: address });
    await client.connect(network);
    return { client, address: address.toLowerCase(), mode };
  }

  const account = createAccount(loadOrCreatePrivateKey());
  const client = createClient({ chain: net.chain, account });
  return { client, address: account.address.toLowerCase(), mode: "local" };
}

// genlayer-js can return Maps and bigints from calldata; make them plain.
export function plain(value) {
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

export async function read(client, address, functionName, args = []) {
  const out = await client.readContract({ address, functionName, args, jsonSafeReturn: true });
  return plain(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAILED_STATES = {
  UNDETERMINED: "Validators could not agree on a result. Nothing was recorded. Try again.",
  CANCELED: "The transaction was canceled before it ran.",
  VALIDATORS_TIMEOUT: "Validators took too long to respond. Nothing was recorded. Try again.",
  LEADER_TIMEOUT: "The lead validator took too long to respond. Nothing was recorded. Try again.",
};

export function describeError(err) {
  const raw = String(err?.shortMessage || err?.message || err || "Unknown error");
  if (/user rejected|denied|rejected the request/i.test(raw)) return "You declined the request in your wallet.";
  if (/insufficient funds|gas/i.test(raw) && /fund|balance/i.test(raw)) {
    return "This account has no funds for fees. Fund it from the network faucet and try again.";
  }
  if (/fetch|network|ECONN|Failed to fetch/i.test(raw)) {
    return "Could not reach the network endpoint. Check the network setting and your connection.";
  }
  return raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
}

function executionError(tx) {
  const failed =
    tx?.txExecutionResultName === "FINISHED_WITH_ERROR" ||
    tx?.consensus_data?.leader_receipt?.some((r) => r?.execution_result === "ERROR");
  if (!failed) return "";
  const lr = tx?.consensus_data?.leader_receipt?.[0];
  const detail = (lr && (lr.error || (typeof lr.result === "string" ? lr.result : ""))) || "";
  return detail ? `The contract rejected this: ${String(detail).replace(/^.*UserError:?\s*/s, "")}` : "The contract rejected this transaction.";
}

/**
 * Send a write call and report each stage through onUpdate.
 * Resolves when the transaction is ACCEPTED (state is readable); keeps watching
 * for FINALIZED in the background. Rejects with a readable Error on failure.
 *
 * onUpdate({ phase, status?, hash?, message? })
 *   phase: "signing" | "submitted" | "consensus" | "accepted" | "finalized" | "failed"
 */
export async function sendTx({ client, address, functionName, args, onUpdate, timeoutMs = 10 * 60_000, pollMs = 2000, finalityTimeoutMs = 60 * 60_000 }) {
  onUpdate({ phase: "signing" });
  let hash;
  try {
    hash = await client.writeContract({ address, functionName, args, value: 0n });
  } catch (err) {
    const message = describeError(err);
    onUpdate({ phase: "failed", message });
    throw new Error(message);
  }
  onUpdate({ phase: "submitted", hash });

  const started = Date.now();
  let lastStatus = "";
  let acceptedTx = null;

  while (Date.now() - started < timeoutMs) {
    let tx;
    try {
      tx = await client.getTransaction({ hash });
    } catch {
      await sleep(pollMs); // transient RPC hiccup: keep polling
      continue;
    }
    const status = String(tx?.statusName ?? tx?.status ?? "");

    if (status && status !== lastStatus) {
      lastStatus = status;
      if (status !== "ACCEPTED" && status !== "FINALIZED") onUpdate({ phase: "consensus", status, hash });
    }

    if (FAILED_STATES[status]) {
      const message = FAILED_STATES[status];
      onUpdate({ phase: "failed", status, hash, message });
      throw new Error(message);
    }

    if (status === "ACCEPTED" || status === "FINALIZED") {
      const rejected = executionError(tx);
      if (rejected) {
        onUpdate({ phase: "failed", status, hash, message: rejected });
        throw new Error(rejected);
      }
      acceptedTx = tx;
      onUpdate({ phase: status === "FINALIZED" ? "finalized" : "accepted", status, hash });
      break;
    }
    await sleep(pollMs);
  }

  if (!acceptedTx) {
    const message = "Timed out waiting for validators. The transaction may still complete; check the explorer.";
    onUpdate({ phase: "failed", hash, message });
    throw new Error(message);
  }

  if (String(acceptedTx.statusName ?? acceptedTx.status) !== "FINALIZED") {
    watchFinality({ client, hash, onUpdate, pollMs: pollMs * 4, timeoutMs: finalityTimeoutMs });
  }
  return { hash, tx: acceptedTx };
}

// Finalization can take a long time on public networks; this never blocks the UI.
async function watchFinality({ client, hash, onUpdate, timeoutMs = 60 * 60_000, pollMs = 8000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    try {
      const tx = await client.getTransaction({ hash });
      const status = String(tx?.statusName ?? tx?.status ?? "");
      if (status === "FINALIZED") {
        onUpdate({ phase: "finalized", status, hash });
        return;
      }
      if (FAILED_STATES[status]) return;
    } catch {
      /* keep trying */
    }
  }
}
