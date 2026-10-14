# Changelog

## 0.1.1 — 2026-10-14

### Fixed — a generic file read was treated as verifying a claim

`CLAIM_VERIFIED` was answered by `file-read`, on the theory that "verified" means
"someone looked". It does not. The consequence was that
`git commit -m "verified on Windows"` **passed as soon as any file had been read in
the session**, because a generic read was accepted as evidence for a specific
verification. The gate agreed with a claim it had no basis to agree with, which is
the one direction a gate must never fail in.

This survived the whole test suite because the test that covered it used a fresh
ledger, and a fresh ledger produces the `review` verdict by the *other* branch —
`ledger-empty-so-unknowable`. The right answer for the wrong reason is still the
wrong reason, and it hid the defect completely. It was found by driving the
published package end-to-end rather than by the suite, which is why the suite now
has a test that populates the ledger first.

`verify` is now mapped to **no** observable evidence. Such a claim lands in
`tool_unverified`: this gate cannot confirm or contradict it, and saying
"unbacked" would be an accusation it cannot support.

The distinction the fix preserves: `file-read` still answers claims about files and
lines, because there reading the file *is* the connection. `cli` claims are still
answered by a CI observation.

Two tests were added (59 → 61): one pinning that a generic read does not verify a
claim, and one pinning that citing a file still is answered by having read it.

### Changed — READMEs

The claim table notes that `CLAIM_VERIFIED` is answered by no observable evidence,
rather than leaving a reader to infer it from the verdict tables.

## 0.1.0 — 2026-10-14

First release. A deterministic pre-claim gate for `git commit`, `git push`,
`git tag`, and README-shaped writes.

### What it does

`tools/post-execute` records what the session actually ran into an in-memory
ledger. Before a gated action runs, `tools/pre-execute` reads the action's own
text, works out which claims that text makes, and checks the ledger for them. A
claim with no backing evidence is stopped.

No model, no network, no runtime dependencies.

### The name

`dsh-preclaim`. The obvious names are held by other authors, some of them for
plugins asking the same question — `dsh-evidence-gate` (lory.top, 0.1.0),
`dsh-evidence` (tudamu, 0.0.1), `dsh-claim-gate`, `dsh-attest`. This release
started under `dsh-evidence-gate` before the registry was checked, which would have
been an unshippable package name. The project's design document had already caught
this and picked `dsh-preclaim`; `scripts/verify-artifacts.mjs` now fails the build
if a later edit drifts back onto a name somebody else owns.

The GitHub repository is `Phocinae/dsh-evidence`, which is free.

### Defects found and fixed before release

Every one of these came from the test suite, and every one was a way for the gate
to be **silently useless** rather than visibly broken.

**The trigger never fired on any real host.** Triggers were written as commands
(`git commit*`) but matched only against the tool *name*. The shell tool is called
`pwsh` on Windows and `bash` elsewhere, so no trigger could ever match and the gate
would have shipped reporting nothing and blocking nothing. A trigger now matches
the tool name **or** the command text, because both host shapes exist, and command
text is classified per operator-separated segment so `cd repo && git commit -m x`
cannot slip past on a prefix.

**The glob matcher silently matched nothing.** The escape class
`/[.+?^${}()|[\]\\]/g` is not a valid character class — the unescaped `[` closes it
— so the asterisk was never escaped, the trailing substitution found nothing to
replace, and the result was a bare quantifier on the preceding character. Every
glob trigger failed, and this showed up as twelve test failures all tracing to one
line.

**The path glob had the same shape of bug.** `**` was substituted to `.*` and then
the following rule for `*` matched the `*` **inside that freshly written `.*`**,
turning it into `.[^/]*`. So `docs/**/*.md` matched nothing — silently, because a
glob that matches nothing is indistinguishable from a path outside its scope. Both
glob sites now substitute in a single pass so no substitution can see another's
output.

**An unreadable result became `allow`.** `toPreToolDecision` treated both
`gate_decision === 'allow'` and a null or missing decision as allow, so an empty or
malformed gate result would have let the action through. Only an explicit `allow`
produces `{kind: 'allow'}` now.

### Design decisions worth stating

* **A claim cannot satisfy its own obligation.** The action under review is never
  consulted for evidence, so a commit message saying "ran pytest; all tests pass"
  contributes nothing to its own check. Pinned by a test.
* **A failed test run is not evidence that tests pass.** `mustSucceed` is set per
  evidence kind: `test-run` and `build-run` require success; `ci-check` and
  `file-read` do not, because observing a red pipeline is still observing it.
* **An unknown outcome is not a failure.** `extractSuccess` returns `null` when the
  payload does not say, which satisfies nothing that requires success.
* **An empty ledger says it cannot tell.** "It did not happen" and "I did not see
  it" are different facts, and an empty ledger cannot distinguish them. It produces
  neither a pass nor a factual accusation.
* **A claim nothing observable could answer is not called unbacked.** A commit
  citing a hash gets `tool_unverified`, because calling it "unbacked" would be an
  accusation the gate cannot support.
* **`next()` is called exactly once, and only on the allow path.**
* **There is no configuration value that lets an unbacked claim through.**
  `resolveConfig` throws on `decision: allow`. A gate with an off switch is a gate
  that gets switched off.
* **ANSI escapes are stripped before claim detection.** Real captured output can
  carry them through a pipe, and every plain-text pattern fails on the escaped
  form — which would make the gate stop recognising the commands it exists to
  inspect.
* **Splitting respects quotes.** Splitting on `;` alone cuts
  `git commit -m "a; b"` in half, and the surviving half no longer looks like a
  commit, so a claim inside a message would be missed.

### Not built, on purpose

The design specifies an optional second tier: a single call to the local 150M
Phocinae model when the deterministic layer lands in a grey zone, fail-closed if
the service is unreachable. It is not here. The result object already carries
`model_verdict` and `model_calls`, and `model_calls` reports `0` because it is a
real counter. Adding a model tier needs a measurement rather than an assumption,
and shipping the counter honestly at `0` is better than shipping an unmeasured
tier.

### Scope, stated plainly

This is text matching over a session ledger. It is not a sandbox and not a defence
against a session that wants to deceive it: `git commit -m "$(cat claim.txt)"`, an
unrecognised test command, or simply not using git all go around it. It catches the
ordinary case of a claim written slightly ahead of the work. The README says so
rather than implying otherwise.
