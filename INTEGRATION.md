# How the web app talks to the contract

The app is in `frontend/`. Every contract method is called through `genlayer-js`
in `frontend/src/chain.js`:

- reads: `client.readContract({ address, functionName, args })` (`read()`, line ~83)
- writes: `client.writeContract({ address, functionName, args, value: 0n })` (`sendTx()`, line ~130),
  then it polls the transaction through sign, submit, consensus, accepted and finalized
  and reports each stage to the transaction tray in the UI.

`frontend/src/main.js` is the only file that chooses which method to call.

| Contract method (`contracts/citation_resurrection.py`) | Kind | Called from `frontend/src/main.js` | What the user does |
|---|---|---|---|
| `lookup(url)` | view | `scanDocument()` | Pastes a document in "Heal a document"; every link is looked up and verified replacements are patched into the right-hand pane |
| `get_count` | view | `refreshCases()` | Opens the Cases tab |
| `list_cases(offset, limit)` | view | `refreshCases()` | Browses cases |
| `get_case(id)` | view | `loadCase()`, propose handler | Reads the fact matrix, proposals and snapshot |
| `open_case(dead_url, snapshot_url, context, facets)` | write | `submitReport()` (`runTx("Open case", "open_case", ...)`) | "Report a dead link" form |
| `get_last_report(address)` | view | `submitReport()` | Reads why a case was or was not opened |
| `propose(case_id, replacement_url)` | write | propose-form handler in `renderCase()` | "Propose replacement" on a case |

`get_finder` and `normalize` are also public views (used by tests and other contracts); the UI does not call them.

URL handling that must match the contract exactly (`normalizeUrl`, snapshot parsing) is in
`frontend/src/urls.js`, and `tests/vectors.json` (generated from the Python contract) is checked
by `frontend/test/urls.test.mjs` so the two languages cannot drift apart.

## Running it against a real contract

1. Deploy: `cd frontend && npm install && PRIVATE_KEY=0x... NETWORK=studionet node scripts/deploy.mjs`
2. `VITE_CONTRACT_ADDRESS=0x... npm run dev` (or paste the address into the app's settings).

`npm run dev:demo` runs the same UI against a simulated chain in `src/demo/mock-chain.js`.
That file is only included in the demo build; the normal build never contains it.
