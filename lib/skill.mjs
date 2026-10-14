/**
 * The bundled skill.
 *
 * Teaches the model the one thing it cannot infer: that a claim in a commit
 * message, a push, or a README is checked against what the session actually ran,
 * so writing "tests pass" without running them is not a shortcut — it is the
 * thing that gets stopped.
 *
 * Generated from the live configuration rather than hand-written, because a
 * hand-written skill drifts from the config it describes and then teaches the
 * wrong thing.
 */
import { CLAIM_PATTERNS, REASON_CODES } from './constants.mjs'

export const SKILL_NAME = 'preclaim'

export function createSkill(config, ledger) {
  const tools = config.triggerTools.map((tool) => `\`${tool}\``).join(', ')
  const globs = config.readmeGlobs.map((glob) => `\`${glob}\``).join(', ')
  const patterns = CLAIM_PATTERNS
    .map((pattern) => `| \`${pattern.id}\` | ${pattern.describes} |`)
    .join('\n')

  const body = `# preclaim — claims are checked against what actually ran

This session gates certain actions. Before one runs, the gate reads the action's
own text. If that text asserts that something was verified, the gate looks for the
verification **in what this session actually did** — not in the text, and not in
the transcript.

## What is gated

* shell calls (${tools}) that run \`git commit\`, \`git push\` or \`git tag\`;
* writes to README-shaped paths (${globs}).

Read-only git verbs (\`status\`, \`log\`, \`diff\`, \`show\`, \`branch\` …) are never
gated, and neither is \`--dry-run\` / \`--help\` / \`--version\` — those make no
claim. A commit with no claim in its message is never gated either.

## What counts as a claim

| pattern | what it notices |
|---|---|
${patterns}

## What this means for you

1. **Do not write a claim you have not earned.** \`git commit -m "fix: tests pass"\`
   when no test run is recorded in this session will be stopped. That is the gate
   working, not a tool failure.
2. **Run the thing, then claim it.** The order matters: the gate reads a ledger of
   completed calls, so a test run that has not happened yet satisfies nothing.
3. **A failed test run does not count as evidence that tests pass.** Running
   \`pytest\`, watching it fail, then committing "tests pass" is stopped. Fix the
   tests, or say what is actually true.
4. **If you are stopped, change the claim or do the work.** Do not reword the
   message to slip past the gate. The pattern table is public and it is checked
   by tests; rewording around it produces a commit whose message is now carefully
   untrue, which is worse than the original overstatement.

## Checking before you act

Call \`evidence_status\` with the text you intend to use:

\`\`\`
evidence_status({ text: "fix: tests pass" })
\`\`\`

It reports which claims the text makes, whether this session has the evidence, and
what the gate would decide. Call it *before* the commit, so a stop costs a rewrite
rather than a rejected action.

## When the gate asks rather than decides

If this session has recorded no evidence at all — the plugin loaded mid-session,
or nothing evidence-shaped has run yet — the gate cannot tell "the tests did not
run" from "I did not see them run". It says so, in those words
(\`${REASON_CODES.LEDGER_EMPTY}\`). An honest "I cannot tell" is worth more than a
confident wrong answer, and it is why an empty ledger never produces a pass.

## What this plugin does not do

It does not read the transcript, does not call a model, and does not judge whether
your work is good. It checks one narrow thing: whether a claim and the session's
record of itself agree.
`

  return {
    name: SKILL_NAME,
    description:
      'How the preclaim gate works: claims about verification in git commit / push '
      + 'messages and README writes are checked against what this session actually ran.',
    body,
    // Exposed so a test can assert the skill is generated from the live config.
    triggerTools: config.triggerTools.slice(),
    readmeGlobs: config.readmeGlobs.slice(),
    ledgerStats: ledger.stats(),
  }
}
