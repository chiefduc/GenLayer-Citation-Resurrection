# Citation Resurrection

A GenLayer project that heals dead links with evidence. Validators verify that a replacement page really states what the original citation was relied on for.

## The web app
The app in `frontend/` (Vite + genlayer-js) reads with `readContract` and writes with `writeContract` (`frontend/src/chain.js`), and shows every transaction stage. See `docs/INTEGRATION.md` for the exact call sites.

## How it works
1. **Open case**: report a dead URL with an Internet Archive snapshot, the citing sentence and 1-4 specific facts. Validators check the link is dead, the snapshot is that page, and it states every fact. Otherwise nothing is stored and the reason is readable via `get_last_report`.
2. **Propose**: anyone proposes a replacement. Validators judge it against the frozen snapshot. Only every fact YES with relation SAME_DOCUMENT or DIFFERENT_SOURCE heals; the first such proposal closes the case. Reporters earn no credit for healing their own case.
3. **Lookup**: `lookup(url)` returns cases and verified replacements for any consumer.

Design: the model returns structured evidence; deterministic code computes the verdict; parsing fails closed; custom validators re-fetch and agree within a tolerance (`run_nondet_unsafe`).

## Layout
- `contracts/citation_resurrection.py` the Intelligent Contract
- `tests/` Python tests (`python3 -m pytest tests`), `gen_vectors.py` writes parity vectors
- `frontend/` Vite + genlayer-js app (full tx lifecycle: sign, submit, consensus, accepted, finalized)
- `docs/INTEGRATION.md` **which UI action calls which contract method, and where in the source**
- `assets/` logo, `SUBMISSION.md` form text
- `.github/workflows/` CI (tests + builds) and GitHub Pages deploy

## Run
```
cd frontend && npm install
npm test
npm run dev:demo        # simulated chain, fake validators, no node needed
node scripts/deploy.mjs # deploy to Studio (needs a funded/Studio key; see script)
VITE_CONTRACT_ADDRESS=0x... npm run dev
```
Deploy to GitHub Pages with `.github/workflows/pages.yml` after setting the `VITE_CONTRACT_ADDRESS` repo variable.

## Limits and honesty
Not yet run on a live network; SDK calls follow GenLayer docs from memory and need verifying on Studio. LLM judgement quality and the soft-dead heuristic (a transient fetch failure may read as dead) are untested in the wild. Browsers cannot fetch arbitrary URLs (CORS), so deadness is judged on-chain only. Browser-wallet mode is beta.
