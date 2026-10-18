// Deploy contracts/citation_resurrection.py with genlayer-js.
//
//   PRIVATE_KEY=0x... NETWORK=studionet node scripts/deploy.mjs
//
// NETWORK is one of: studionet (default), localnet, testnetBradbury, testnetAsimov.
// Without PRIVATE_KEY a throwaway key is generated and printed (fine for Studio,
// useless on a testnet that needs funds).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet, localnet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const chains = { studionet, localnet, testnetAsimov, testnetBradbury };
const network = process.env.NETWORK || "studionet";
if (!chains[network]) {
  console.error(`Unknown NETWORK "${network}". Use one of: ${Object.keys(chains).join(", ")}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, "..", "..", "contracts", "citation_resurrection.py"), "utf8");

let pk = process.env.PRIVATE_KEY;
if (!pk) {
  pk = generatePrivateKey();
  console.log(`No PRIVATE_KEY given. Generated one (save it if you want to reuse this account):\n  ${pk}\n`);
}
const account = createAccount(pk);
const client = createClient({ chain: chains[network], account });

console.log(`Deploying to ${network} from ${account.address} ...`);
const hash = await client.deployContract({ code, args: [] });
console.log(`Deploy transaction: ${hash}`);

const receipt = await client.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 200 });
const address =
  receipt?.data?.contract_address ??
  receipt?.txDataDecoded?.contractAddress ??
  receipt?.recipient ??
  receipt?.to_address;

if (!address) {
  console.error("Deployed, but the contract address was not found in the receipt. Inspect it:");
  console.error(JSON.stringify(receipt, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(2);
}
console.log(`\nContract address: ${address}`);
console.log(`Paste it into the app settings, or set VITE_CONTRACT_ADDRESS=${address} in frontend/.env`);
