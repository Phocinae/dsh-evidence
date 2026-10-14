# preclaim

A claim about what was verified is not the same as the verification. This skill
covers the gate that checks one against the other.

## What is gated

`git commit`, `git push`, `git tag`, and writes into README-shaped paths
(`README*`, `CHANGELOG*`, `docs/**/*.md`). Before such an action runs, the gate
reads the action's own text. If that text asserts something was verified, the gate
looks for it **in what this session actually did** — not in the text, and not in
the transcript.

Read-only git verbs (`status`, `log`, `diff`, `show`, `branch` …) are never gated,
and neither are `--dry-run`, `--help` or `--version`: those make no durable claim.
A commit whose message asserts nothing is never gated either.

## Working with it

**Do not write a claim you have not earned.** `git commit -m "fix: tests pass"`
with no recorded test run will be stopped. That is the gate working.

**A failed test run is not evidence that tests pass.** Running `pytest`, watching
it fail, then committing "tests pass" is stopped. So is a run whose outcome the
session never saw.

**Check before you act.** `evidence_status({ text: "..." })` reports what that
text asserts, whether the session has the evidence, and what the gate would
decide. One call is much cheaper than a rejected action.

**If you are stopped, change the claim or do the work.** Do not reword the message
to slip past the gate. The pattern table is public and it is checked by tests;
rewording around it produces a commit whose message is now carefully untrue, which
is worse than the original overstatement.

## When it asks instead of deciding

If the session has recorded no evidence at all — the plugin loaded mid-session, or
nothing evidence-shaped has run yet — the gate cannot tell "the tests did not run"
from "I did not see them run". It says so, in those words. An empty ledger never
produces a pass, and it never produces the accusation of an unbacked claim either:
the answer to "I cannot tell" is a question.

## What it does not do

No model, no network, no reading of the transcript. It does not judge whether the
work is good, only whether a claim and the session's record of itself agree.
