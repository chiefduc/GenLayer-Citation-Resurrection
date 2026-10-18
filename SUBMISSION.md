# Citation Resurrection: Project Explorer submission

Copy each block into the matching form field. Character counts are checked by `python3 check_limits.py`.

## Logo
`assets/logo.png` (512x512 PNG, under 2MB). Source: `assets/logo.svg`.

## Project name
Citation Resurrection

## Tags
The dropdown options were not visible to me, so pick the closest. Suggested: primary **Infrastructure / Public goods** (or the nearest "tooling" tag), secondary **Knowledge / Data** and **Consensus**.

## One-liner (max 180)
A registry where validators verify that a replacement page truly states what a dead citation was relied on for, so broken links get healed with evidence.

## Description (max 1000)
Links rot, and replacing a dead source with "a similar page" is a guess. Citation Resurrection makes it verifiable. Someone reports a dead link with an Internet Archive snapshot and one to four specific facts the citation supported. Validators independently confirm the link is really dead, the snapshot is really that page, and the snapshot really states every fact; otherwise no case opens. Anyone can then propose a replacement. Validators read it live and compare it with the frozen snapshot: same document at a new address, or an independent source stating every fact. Only full fact coverage heals a case; partial support and unrelated pages are rejected. The model returns structured evidence and deterministic code computes the verdict, so injected page text cannot force a result. Any document, bot or contract can call lookup(url) to get the verified replacement. The web app lets you paste a document and see dead links patched, with each repair showing what it was checked against.

## Demo URL (optional)
TODO: paste your YouTube or X link after recording (script below).

## The exact path (steps)
1. **Open the site.** Heading: "Heal a document". Click "Try a sample" and watch links with verified replacements get struck through and patched in the right-hand pane.
2. **Report a dead link.** Heading: "Report a dead link". Enter a dead URL, click "Find snapshot" (or paste a web.archive.org snapshot of that page), write the citing sentence and one to four specific facts. Click "Open case" and sign.
3. **Watch consensus.** The transaction tray shows signing, submitted, validators working, accepted and finalized. The result says either "Case #N is open" or why no case was opened.
4. **Propose a replacement.** Heading: "Cases". Open your case, paste a live https page that states every fact, click "Propose replacement" and sign.
5. **Read the verdict.** The fact matrix shows YES, PARTIAL or NO per fact for the snapshot and each proposal. A full match heals the case.
6. **Reuse it.** Back in "Heal a document", paste text containing the dead link: it is now patched with the verified replacement.

## Expected verification outcome (max 500)
A new case appears in Cases with status Open. After a proposal that states every fact, the case shows Healed, the winning proposal's relation (same document or independent source) and a fact matrix with all YES. Pasting the old URL into "Heal a document" shows it struck through and replaced. A link that is still alive, or facts the snapshot does not state, produce "No case was opened" with the reason.

## Contract links (optional)
TODO: after deploying, paste the explorer address URL for the CitationResurrection contract.

## Website (required)
TODO: GitHub Pages URL from `.github/workflows/pages.yml` (e.g. https://<user>.github.io/citation-resurrection/). Set repo variable `VITE_CONTRACT_ADDRESS` first.

## GitHub / Evidence repo
TODO: https://github.com/<user>/citation-resurrection

## Demo video script (about 90 seconds)
1. Problem (10s): a citation to a page that is now a 404.
2. Heal tool (20s): paste the sample, show strike-through and patched links.
3. Report (25s): open a case, show the tray reach accepted.
4. Propose (20s): add a replacement, show the fact matrix and Healed.
5. Close (15s): the contract is a public lookup anyone can call.

## Draft post
Dead links are a trust problem, not a search problem. Citation Resurrection on @GenLayer: validators check that a replacement page truly states the facts a citation was used for, judged against an immutable Internet Archive snapshot. Paste a document, see it healed. <site> <repo>

## Honest status
Not yet run on a live GenLayer network. Contract logic and parsing are unit tested (75 Python tests, URL/chain JS tests with Python/JS parity vectors). The `--mode demo` build uses a simulated chain with fake keyword validators and says so on screen. Deploy to Studio, set the address, and verify before submitting.
