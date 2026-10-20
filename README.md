# dsh-preclaim

> **Repository name vs package name:** the repo is `dsh-evidence`; the npm package is `dsh-preclaim`. They are the same plugin.


**A commit message that says "tests pass" is a claim. This checks it against what
the session actually ran — and stops the commit if the two disagree.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
No model, no service, no network, no API key.

```
$ git commit -m "fix: parser handles empty input; tests pass"

  dsh-preclaim: this session has recorded no evidence at all, so this gate cannot
  tell "it did not happen" from "I did not see it"
  — asserted: CLAIM_TEST_PASSED

  [review] commit anyway, or run the tests first?
```

> **Why `preclaim` and not `evidence-gate`?** Because the obvious names are held by
> other authors, some of them for plugins asking the same question:
> `dsh-evidence-gate` (lory.top), `dsh-evidence` (tudamu), `dsh-claim-gate`,
> `dsh-attest`. The project's design document checked the registry and picked the
> free name that describes the right moment: **before the claim is written down.**
> `scripts/verify-artifacts.mjs` fails the build if a later edit drifts back onto a
> name somebody else owns.

## Quick start

```sh
dsh plugin --profile web add dsh-preclaim@0.1.2
```

evidence_status / the pre-execute gate is now available; The gate records what ran in the session and checks a commit/push/README claim against that ledger before it is written.


## Why this exists, and why it is not a model

The failure it targets is not a judgement call. "The message claims tests pass"
and "no test run is recorded in this session" are both facts, and whether they
agree is decidable. A model here would add a confidence interval to a yes/no
question, and would occasionally be wrong in a way nobody could reproduce.

So the whole plugin is deterministic:

* **`tools/post-execute` records what ran** into an in-memory ledger for the
  session.
* **`tools/pre-execute` reads that ledger** before a gated action runs.

Three consequences follow from that split, and they are the design rather than
implementation details:

1. **A claim cannot satisfy its own obligation.** The action under review is never
   consulted for evidence. A commit message saying "ran pytest; all tests pass"
   contributes nothing to its own check.
2. **A failed test run does not count as evidence that tests pass.** `test-run` and
   `build-run` require success. `ci-check` and `file-read` do not: observing a red
   pipeline is still observing the pipeline, and reading a file is evidence of
   reading it whatever the exit code.
3. **Nothing is inferred from prose.** The ledger holds what the host reported, and
   nothing else. There is no transcript reading and no heuristic scanning.

## Install

```sh
dsh plugin --profile <name> add dsh-preclaim@0.1.2
```

The bundled patch arms the gate on activation. Every key has a default, so it
works with no configuration at all.

## What is gated

**Shell calls** running an asserting git verb — `commit`, `push`, `tag`. A commit
carries its message inline; a push asserts through the commits it carries, so the
command text is checked and the commit range is left to the human.

Read-only verbs (`status`, `log`, `diff`, `show`, `branch`, `rev-parse`, …) are
never gated, and neither are `--dry-run`, `--help`, `-h` or `--version`: none of
those makes a durable claim. `git fetch && git commit -m x` gates the commit and
not the fetch.

**README-shaped writes** — `README*`, `CHANGELOG*`, `docs/**/*.md`, `**/README.md`.
A README is where a project states what it does and whether it works. Ordinary
source writes are left alone; gating those would put a gate in front of every edit.
A write outside the working directory is not judged at all.

## What counts as a claim

| pattern | what it notices | answered by |
|---|---|---|
| `CLAIM_TEST_PASSED` | says tests pass | a recorded test run |
| `CLAIM_VERIFIED` | says something was verified | **nothing observable** → `tool_unverified` |
| `CLAIM_RAN_CHECK` | says a check was run | a recorded test run |
| `CLAIM_BUILD_OK` | says the build succeeds | a recorded build |
| `CLAIM_CLI_ASSERTION` | names a CLI invocation | a CI observation |
| `CLAIM_DEPENDENCY` | asserts a platform dependency | **nothing observable** → `tool_unverified` |
| `CLAIM_LINE_REF` | cites a line | a file read |
| `CLAIM_COUNT` | cites a count | **nothing observable** → `tool_unverified` |
| `CLAIM_HASH_REF` | cites a commit hash | **nothing observable** → `tool_unverified` |
| `CLAIM_FILE_EXISTS` | cites a file | a file read |

The last column has a rule behind it: **evidence has to connect to the claim it
answers.** `file-read` answers a citation of a file or a line, because reading that
file *is* the connection. It does **not** answer "this was verified" — reading
*some* file is not verifying *that* claim. An earlier version treated it as if it
were, which made `git commit -m "verified on Windows"` pass as soon as anything at
all had been read.

The four kinds mapping to nothing are not an oversight. They are claims this gate
can observe but cannot adjudicate, so it says so and asks
(`tool_unverified`) rather than making an accusation it cannot support.

If no pattern matches, the action is allowed with `no-claim-in-action`. The patterns
are deliberately syntactic: a wider net means more false stops on honest work, and a
gate that cries wolf gets switched off — after which it checks nothing at all.

## What happens on a miss

| situation | verdict | why |
|---|---|---|
| not a watched action | `allow` | nothing to check |
| a watched action carrying no claim | `allow` | still nothing to check |
| every claim backed by recorded evidence | `allow` | the claim and the record agree |
| a claim with no evidence, ledger populated | `review` | the claim is not backed |
| **the ledger is empty** | `review`, and says so | cannot distinguish "it did not happen" from "I did not see it" |
| a claim no observable evidence could answer | `review` (`tool_unverified`) | a limit of this gate, not an accusation |
| the gate itself throws | `review` | a defect must not become a silent allow |

Two of those rows are worth reading twice.

**The empty ledger** happens whenever the plugin loads mid-session, or when
recording failed. Reporting "the tests did not run" in that state would be a
confident wrong answer. The gate says what it actually knows instead — and an empty
ledger **cannot** produce either a pass or a factual accusation.

**`tool_unverified`** is the honest answer for a claim this plugin could never
check. A commit saying `reverts abc1234` cites a hash; nothing the ledger observes
confirms or contradicts that. Calling it "unbacked" would be an accusation the
gate cannot support, so it says so and asks.

Set `decision: deny` to refuse outright instead of asking.

## Configuration

```yaml
- insert:
    - id: preclaim
      name: dsh-preclaim
      config:
        triggerTools: [pwsh, bash, write, edit, str_replace_editor]
        readmeGlobs: ['README*', 'CHANGELOG*', 'docs/**/*.md', '**/README.md']
        decision: review      # review | deny
        audit: true
        ledgerLimit: 500
        pushMessageLimit: 20
```

There is deliberately **no** configuration value that lets an unbacked claim
through. `decision` chooses between asking and refusing, and nothing else — a gate
with an off switch is a gate that gets switched off. `resolveConfig` throws on
`decision: allow`.

`pushMessageLimit` caps how many commit messages a push is checked against, so the
cost does not grow with repository age. The cap is reported when it bites, because
a silently truncated check reads as a complete one.

## The `evidence_status` tool

```
evidence_status({ text: "fix: tests pass" })
```

Reports the ledger's state, which claims that text makes, whether the session has
the evidence, and what the gate would decide. Call it *before* acting, so a stop
costs a rewrite rather than a rejected action.

## Two parsing details that are load-bearing

**ANSI escapes are stripped before anything else.** Captured output can carry
escape sequences even through a pipe, so a flag can arrive as
`\u001b[1;33m--version\u001b[0m`. Every plain-text pattern then fails to match and
the gate silently stops recognising the commands it exists to inspect.

**Commands are split on operators that are not inside quotes.** Splitting on `;`
alone cuts `git commit -m "a; b"` in half, and the surviving half no longer looks
like a commit — so a claim inside a message would be missed entirely.

Both are pinned by tests.

## What it does not do

It does not read the transcript, does not call a model, and does not judge whether
the work is good. It checks one narrow thing: whether a claim and the session's
record of itself agree.

It also does not persist the ledger. Evidence is a property of *this* session, so a
ledger restored from disk would be evidence for a different run.

**It is a seatbelt, not a sandbox.** Everything here is text matching over a
ledger. `git commit -m "$(cat claim.txt)"`, a test command the patterns do not
recognise, or simply not using git all go around it. It catches the ordinary case —
a claim written slightly ahead of the work — and it is not a defence against a
session that wants to deceive it. Do not describe it as one.

## Deliberately not built yet

The project's design specifies an optional second tier: when the deterministic
layer lands in a grey zone, ask the local 150M Phocinae model once, and fail closed
if the service is unreachable. **That tier is not in this release.** The result
object already carries the fields it would fill (`model_verdict`, `model_calls`),
and `model_calls` is reported as `0` because it is a real counter.

It is left out because the deterministic tier is where the measured value is, and a
tier that adds a model call needs the same evidential standard as everything else —
a measurement, not an assumption. Shipping the counter and calling it `0` is more
honest than shipping a tier nobody measured.

## Requirements

Node `^22.19.0 || >=24.0.0`. No runtime dependencies. `@deepseek-ai/cordis` is an
optional peer.

## Testing

```sh
npm test                  # 61 assertions, no host required
npm run verify:artifacts   # what npm publish would actually ship
```

The suite covers shell parsing (ANSI, quoting, operators, `-C`, read-only verbs,
dry-run suppression), the claim table, the ledger's per-kind success rules, glob
matching after path normalisation, `next()` call discipline, and the "must never
allow" paths: an unknown decision, a throw inside the gate, and a payload with no
tool name.

## License

Apache-2.0.