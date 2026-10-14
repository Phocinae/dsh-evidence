# dsh-preclaim — architecture

## In one line

`tools/post-execute` records **what actually ran**. `tools/pre-execute` reads that
record before a `git commit` / `git push` / `git tag` / README-shaped write runs,
extracts the **claims** the action's own text makes, and checks whether the session
has the evidence those claims need. If it does not, the action is stopped.

## Data flow

```
  a tool call finishes
        │
        ▼
  tools/post-execute ──► lib/ledger.mjs
        │                  │  pull out: tool name, command text, success (true / false / null)
        │                  │  decide:   which evidence kinds this call provides, per
        │                  │            EVIDENCE_KINDS + each kind's mustSucceed
        │                  ▼
        │            in-memory session ledger
        │            (bounded, redacted to 400 chars, never written to disk)
        │            entries that provide no evidence are not recorded at all
        │
  the next tool call
        │
        ▼
  tools/pre-execute ──► lib/gate.mjs
        │                  1. is it triggered? (tool name matches a pattern **or** the
        │                     command contains an asserting git verb)
        │                  2. read the action's own text: commit message args, or the
        │                     README-shaped file content (lib/shell.mjs, lib/paths.mjs)
        │                  3. detectClaims(text)            → CLAIM_PATTERNS   (lib/claims.mjs)
        │                  4. evidenceFor(claims, ledger)   → CLAIM_KIND_EVIDENCE + ledger
        │                  5. verdict:
        │                        every claim satisfied      → allow
        │                        no claims at all           → allow  (nothing to check)
        │                        unsatisfied, none answerable → review  (tool_unverified)
        │                        unsatisfied, answerable, ledger empty → review (ledger_empty)
        │                        unsatisfied, answerable, ledger used  → decision (default review)
        ▼
  next() (allow)  |  {kind: 'ask'} (review)  |  {kind: 'deny'} (deny)
```

The gate's own vocabulary is `allow | review | deny` (`GATE_DECISIONS`). The host
waterfall wants `allow | deny | ask`, so `toPreToolDecision` maps `review → ask`.
`next()` is called exactly once, and only on the allow path.

## Why it is shaped this way

### Evidence never comes from the action under review

This is the whole point. If evidence could come from the text being checked, then
`git commit -m "ran pytest; all tests pass"` would satisfy itself and the gate would
be decoration. So `decideCall` uses the candidate action to answer exactly one
question — *what does this claim?* — and never asks it for *what did you do?*.

The ledger is fed only by `tools/post-execute`, i.e. only by calls that already
completed. That is why order matters: a test run that has not happened yet
satisfies nothing. A test pins the separation by name
(`A CLAIM CANNOT SATISFY ITS OWN OBLIGATION`) and additionally asserts that merely
reviewing an action records no evidence.

### `mustSucceed` is per evidence kind, not global

`EVIDENCE_KINDS` gives each kind its own `mustSucceed`. `evidenceFrom` skips a kind
when `spec.mustSucceed` is set and the recorded outcome is not exactly `true`:

| evidence kind | `mustSucceed` | why |
|---|---|---|
| `test-run` | **yes** | a test run that failed is not evidence that tests pass. Counting it would make the gate actively misleading — which is worse than not having the gate |
| `build-run` | **yes** | same argument: a failed build is not evidence that the build succeeds |
| `ci-check` | no | seeing that CI is red is still having seen the CI state |
| `file-read` | no | whether a file was read does not depend on the exit code |

"Unknown" (`null`) and "failed" (`false`) are different facts and neither satisfies a
`mustSucceed` kind. `extractSuccess` returns `null` when the payload does not say —
`{ok: true}`, `{success: false}`, `{error: …}`, `{result: {exitCode}}`,
`{result: {isError}}` are all read, and an unrecognised shape yields `null`, never a
guess.

### An empty ledger is its own branch

An empty ledger means the session recorded no evidence: the plugin loaded
mid-session, or nothing evidence-shaped has run yet. In both, **"the tests did not
run" and "I did not see them run" are informationally identical.** So an empty
ledger produces neither a pass nor a
factual accusation. It produces `review` with reason code
`ledger-empty-so-unknowable`, `uncertain: true`, and a message that says it cannot
tell.

The test for emptiness is `ledger.stats().everRecorded`, not `size === 0`: a ledger
that recorded evidence and then aged it out is not the same as a ledger that never
recorded anything, and only the second one is genuinely unknowable.

### `tool_unverified` is a limit of the gate, not an accusation

Some claim kinds are answered by nothing this plugin can observe. They are listed
explicitly in `CLAIM_KIND_EVIDENCE` as empty arrays rather than omitted, because
"unanswered by design" and "I forgot to add it" look identical in a diff.

| claim kind | answering evidence |
|---|---|
| `test` | `test-run` |
| `build` | `build-run` |
| `cli` | `ci-check` |
| `line` | `file-read` |
| `file` | `file-read` |
| `verify` | *(none — deliberately unanswered)* |
| `platform` | *(none)* |
| `count` | *(none)* |
| `hash` | *(none)* |

Two of those rows carry an argument rather than a mapping:

- **`verify` is deliberately unanswered.** An earlier version mapped it to
  `file-read` and `test-run`, on the theory that "verified" means "someone looked".
  That made `git commit -m "verified on Windows"` pass as soon as *any* file had been
  read in the session — the gate agreeing with a claim on no basis, which is the one
  direction a gate must never fail in. Reading a file is not verifying a claim, and
  the gate cannot connect the two, so `CLAIM_VERIFIED` lands in `tool_unverified`.
- **`line` and `file` keep `file-read`**, because there the connection is real:
  citing a line or a file is answered by having read that file.

`evidenceFor` marks each claim `answerable: kinds.length > 0`. When **every**
unsatisfied claim is unanswerable, calling the action "unbacked" would be an
accusation the gate cannot support, so the verdict is `review` /
`tool-unverified` / `model_verdict: 'tool_unverified'` and the message says it needs
a human. A commit saying `reverts abc1234` cites a hash, and a README saying
"verified on Windows" asserts a verification: nothing the ledger observes confirms or
contradicts either one.

Note the asymmetry: if a mix of answerable and unanswerable claims is unsatisfied,
the answerable ones decide, and the unanswerable ones do not by themselves force
`tool_unverified`.

### Triggering matches the tool name **or** the command text

Either match is enough (`isTriggered`):

- **tool name** against `config.triggerTools`, via `toolMatches` — exact,
  case-insensitive `*` glob, or `*` for everything;
- **command text** classified by `classifyCommand`, if any segment carries an
  asserting git verb.

Both are needed because both host shapes exist. The shell tool on a real host is
called `pwsh` (or `bash`, `zsh`, …), so a trigger written as a command pattern such
as `git commit*` can never match a tool name — the first version of this gate did
exactly that and would have shipped watching nothing while reporting no error. The
other shape is a dedicated tool (`git_commit`, some MCP tool) that carries no command
text at all and can only be recognised by its name.

Command text is split per operator-separated segment before classification, so
`cd repo && git commit -m x` cannot slip past on a prefix. `FOO=1 git commit …` and
`env FOO=1 sudo git commit …` are also recognised: leading `env`, `VAR=value`
assignments, and wrappers (`sudo`, `command`, `nohup`, `time`, `exec`) are stripped
before the verb is read. `git -C /path commit …` is read as a working directory, not
as an argument.

A tool that is neither on `triggerTools` nor carrying an asserting command is not
gated at all. That is the one place where "no match" means `allow`, and it is
correct there for a specific reason: such a call carries *no claim to check*, which
is a different thing from a claim the gate cannot judge.

### ANSI stripping and quote-aware splitting are both load-bearing

Neither is an optimisation; each prevents a silent failure.

**ANSI stripping** comes first, everywhere text is read — `stripAnsi` is applied in
`splitSegments`, in `analyseAction`, and again inside `detectClaims`. Real captured
output carries escape sequences even through a pipe, so `--version` can arrive as
`\u001b[1;33m--version\u001b[0m`. Every plain-text pattern then fails: the
non-asserting flag becomes invisible, the command is treated as asserting, and a
claim split by an escape (`tests \u001b[32mpass\u001b[0m`) stops being found. In
both directions the gate silently stops recognising what it exists to inspect.

**Quote-aware splitting** decides where one command ends. Splitting on `;` alone
cuts `git commit -m "a; b"` in half, and the surviving half no longer looks like a
commit — so a claim inside a message would be missed entirely. `splitSegments`
therefore treats operators inside `'…'` and `"…"` as text, honours backslash
escapes, and treats an unterminated quote as running to end of input (which is the
shell's own reading and the safe one here: at worst a claim is missed, never
invented).

### Globs are matched after normalisation, in one pass

A write is judged only if its path normalises **inside** `cwd`. `normalisePath`
resolves the path, reports `insideCwd`, and returns a forward-slash `relative`, so
`docs/../README.md` and `README.md` are one path. Matching the raw string would let a
traversal spelling escape the gate entirely, and a path outside the working
directory is not judged at all.

`matchesGlobs` tests the relative path and its basename, case-insensitively:
`**/` → optional directory prefix, `**` → crosses directories, `*` → does not, `?`
→ one non-separator character. A gate that fires on Linux and not on Windows is
worse than one that fires on neither.

## Recording, in detail

`createLedger` keeps a bounded array (`ledgerLimit`, default `500`) of
`{toolName, kinds, success, command}`. `command` is redacted to 400 characters plus
an elision marker; the ledger never keeps full transcripts, and it is never
persisted — evidence is a property of *this* session, so a ledger restored from disk
would be evidence for a different run.

Which kinds a call provides (`evidenceFrom`):

| recorded call | kinds |
|---|---|
| `pytest` / `npm test` / `go test` / `node --test` / … with success `true` | `test-run` |
| the same with success `false` or `null` | *(nothing)* |
| `npm run build`, `cargo build`, `dotnet build`, … with success `true` | `build-run` |
| `gh run view` / `gh pr checks` / `gh api` — any outcome | `ci-check` |
| `cat` / `rg` / `Get-Content` / `git diff` / … — any outcome | `file-read` |
| a read-shaped tool (`read`, `view`, `grep`, `list`, …) with **no** command text | `file-read` |
| a shell tool (`pwsh`, `bash`, …) with an unreadable command | *(nothing — the call is not recorded)* |

That last row is deliberate: inferring "it probably ran tests" from a tool named
`bash` would be exactly the kind of guess this plugin exists to avoid. The ledger
also never throws — a malformed payload must not break the host's post-execute
pipeline — and `stats()` reports `{size, limit, dropped, everRecorded}` so that
"empty" is distinguishable from "emptied".

## Failure direction

Every unknown path ends in `review` (or `deny`). None ends in `allow`:

| situation | result | pinned by |
|---|---|---|
| the gate throws internally | `ask`, reason `the gate failed (…)` | `A THROW INSIDE THE GATE BECOMES ASK, NEVER ALLOW` |
| the gate result is `null` / `{}` / an unrecognised `decision` | `ask`, reason "could not interpret" | `toPreToolDecision never returns allow for a non-allow result` |
| the `tools/pre-execute` payload has no usable tool name | `ask`, `payload-had-no-tool-name` | `a payload with no tool name asks rather than allowing` |
| the ledger has never recorded anything and a claim is unmet | `review`, `ledger-empty-so-unknowable` | `an empty ledger asks, and says it cannot tell` |
| the action carries no claim at all | `allow`, `no-claim-in-action` | `a commit with no claim is allowed` |
| nothing the gate observes could answer the claim | `review`, `tool-unverified` | `a claim no evidence could answer is tool_unverified, not a lie` |
| `triggerTools` empty | **throws at load** | `an empty triggerTools list is refused, not treated as a no-op` |
| `readmeGlobs` empty | **throws at load** | `an empty readmeGlobs list is refused` |
| `decision: allow` (or `skip` / `off` / `true`) | **throws at load** | `there is no config value that lets an unbacked claim through` |
| bad `ledgerLimit` / `pushMessageLimit` / `audit` | **throws at load** | `bad numeric and boolean options are refused` |

The last four are deliberate. A configuration error must be loud rather than
degrade silently into a gate that checks nothing — a gate with an off switch is a
gate that gets switched off. `resolveConfig` accepts only `'review'` or `'deny'` for
`decision`; the error message says why there is no `'allow'`. The other two rows
worth reading twice are the `allow` rows: **an action that carries no claim is not
ignorance, it is a fact about the action**, and `allow` is the correct answer to it.

## Scope, and what is deliberately not here

- **No model, no service, no network, no runtime dependency.** "The message claims
  tests pass" and "no test run is recorded" are both facts, and whether they agree is
  decidable. A model would add a confidence interval to a yes/no question.
- **No transcript reading.** The ledger is the only input to a verdict.
- **No persistence.** See above: a restored ledger is another run's evidence.
- **No claim the gate cannot answer is answered by proxy.** `verify` is mapped to no
  evidence at all rather than to a generic read, so "a generic file read does not
  verify a claim" holds as a property of the table rather than of a reviewer's
  attention.
- **Not built: the optional second tier.** The project's design specifies an
  optional tier that would call the local 150M Phocinae model once when the
  deterministic layer lands in a grey zone, and fail closed if the service is
  unreachable. **It is not in this release.** The result object already carries the
  fields it would fill — `model_verdict`, `model_calls` — and `decideCall` reports
  `model_calls: 0` and `model_verdict` values (`evidence_present`, `claim_unbacked`,
  `tool_unverified`) that are honest for a tier that never calls a model. It is left
  out because the deterministic tier is where the measured value is, and a model tier
  needs the same evidential standard as everything else: a measurement, not an
  assumption. Shipping a real counter at `0` is more honest than shipping an
  unmeasured tier.
- **It is a seatbelt, not a sandbox.** Everything here is text matching over an
  in-memory ledger. `git commit -m "$(cat claim.txt)"`, a test command the patterns
  do not recognise, or simply not using git all go around it. It catches the ordinary
  case — a claim written slightly ahead of the work — and it is not a defence against
  a session that wants to deceive it. It should not be described as one.

## Files

| file | role |
|---|---|
| `index.mjs` | composition entry: resolves config, creates the ledger, subscribes `tools/post-execute` (record) and `tools/pre-execute` (gate), injects `tools` / `skills`, exports `createPlugin`, `DEFAULTS`, `PLUGIN_ID`, `BUNDLE_NAME` |
| `tools.mjs` | the `evidence_status` tool definition, its raw JSON Schema (model-facing field is `parameters`, plus `output.schema`), and the dry-run check the tool performs before an action |
| `lib/constants.mjs` | fixed vocabularies: `DEFAULT_TRIGGER_TOOLS`, `DEFAULT_README_GLOBS`, `GIT_ASSERTING_VERBS`, `GIT_READING_VERBS`, `NON_ASSERTING_FLAGS`, `CLAIM_PATTERNS`, `CLAIM_KIND_EVIDENCE`, `EVIDENCE_KINDS` (with `mustSucceed`), `REASON_CODES`, `GATE_DECISIONS`, `LEDGER_LIMIT`, `PUSH_MESSAGE_LIMIT`, `ANSI_RE`, and the `SHELL_TOOL_HINTS` / `WRITE_TOOL_HINTS` tool-name hints the gate matches on |
| `lib/config.mjs` | config resolution and validation (`resolveConfig`) and tool-name matching (`toolMatches`); throws on configuration that cannot be honoured |
| `lib/errors.mjs` | `ERROR_CODES` (`PRECLAIM_BAD_CONTEXT`, `PRECLAIM_BAD_CONFIG`, `PRECLAIM_BAD_PATTERN`) and `PreclaimError` |
| `lib/ledger.mjs` | the session ledger: `extractCommand` / `extractToolName` / `extractSuccess`, `evidenceFrom` (per-kind `mustSucceed`), recording, bounding, `has` / `kinds` / `snapshot` / `stats` |
| `lib/gate.mjs` | `isTriggered`, `analyseAction`, `matchesGlobs`, `decideCall`, `toPreToolDecision`, `createPreExecuteGate` — the verdict and the listener |
| `lib/claims.mjs` | `detectClaims`, `evidenceFor`, `evidenceSummary` — what the text asserts, and whether the ledger answers it |
| `lib/shell.mjs` | `stripAnsi`, `splitSegments`, `tokenize`, `classifySegment`, `classifyCommand`, `commandAsserts` — quote-aware, ANSI-stripped, no process spawning |
| `lib/paths.mjs` | `normalisePath`: absolute/relative resolution against `cwd`, forward-slash relative path, `insideCwd` containment |
| `lib/skill.mjs` | the bundled skill, **generated from the live config** rather than hand-written, so it cannot drift from what is actually gated |
| `scripts/verify-artifacts.mjs` | pre-publish check: the patch names `package.json`'s `name`, `files[]` covers every required file, no tests or scripts ship, the entry imports and exports `createPlugin` |
| `skills/preclaim/SKILL.md` | the static skill text published alongside `lib/skill.mjs` |

`package.json`'s `files` array already lists `ARCHITECTURE.md`, so this document
ships in the tarball; `verify-artifacts.mjs` also asserts that `README.md`,
`CHANGELOG.md`, `LICENSE`, every `lib/*.mjs` file and `skills/preclaim/SKILL.md`
exist and are covered by `files[]`.
