/**
 * dsh-preclaim — a deterministic pre-claim gate for DeepSeek Harness.
 *
 * A claim about what was verified is not the same as the verification. This
 * plugin checks the *action* against the *session record*: if a `git commit`,
 * a `git push`, or a write into a README asserts that something was verified,
 * the gate looks for that verification in what this session actually did.
 *
 * Three properties this is built to have:
 *
 *  1. **No model, no service, no network.** The failure it targets is not a
 *     judgement call: "the message claims tests pass" and "no test run is
 *     recorded" are both facts, and whether they agree is decidable. A model here
 *     would add a confidence interval to a yes/no question.
 *
 *  2. **Recording, not retrospection.** `tools/post-execute` records what really
 *     ran into an in-memory ledger. The gate reads that ledger. Nothing is
 *     inferred from prose and the transcript is never consulted.
 *
 *  3. **Unknowable means ask.** If the ledger is empty because the plugin loaded
 *     mid-session, the gate cannot tell "the tests did not run" from "I did not
 *     see them run". That is `review` with the reason stated — never a pass, and
 *     never the accusation of an unbacked claim.
 *
 * The naming is deliberate and was decided in the project's design document
 * after checking the registry: `dsh-evidence-gate`, `dsh-evidence`,
 * `dsh-claim-gate` and `dsh-attest` are all held by other authors, some of them
 * for plugins asking the same question. "preclaim" is the one this plugin can
 * occupy without colliding, and it names the right moment: before the claim is
 * written down.
 */
import {
  DEFAULT_README_GLOBS,
  DEFAULT_TRIGGER_TOOLS,
  LEDGER_LIMIT,
  PUSH_MESSAGE_LIMIT,
} from './lib/constants.mjs'
import { resolveConfig } from './lib/config.mjs'
import { ERROR_CODES, PreclaimError } from './lib/errors.mjs'
import { createLedger } from './lib/ledger.mjs'
import { createPreExecuteGate, toPreToolDecision } from './lib/gate.mjs'
import { createTools } from './tools.mjs'
import { SKILL_NAME, createSkill } from './lib/skill.mjs'

export const PLUGIN_ID = 'preclaim'
export const BUNDLE_NAME = 'dsh-preclaim'

/** The shipped defaults, exported so a caller can diff against their own. */
export const DEFAULTS = Object.freeze({
  triggerTools: DEFAULT_TRIGGER_TOOLS.slice(),
  readmeGlobs: DEFAULT_README_GLOBS.slice(),
  ledgerLimit: LEDGER_LIMIT,
  pushMessageLimit: PUSH_MESSAGE_LIMIT,
  decision: 'review',
})

export {
  ERROR_CODES,
  PreclaimError,
  SKILL_NAME,
  createLedger,
  createPreExecuteGate,
  createSkill,
  createTools,
  resolveConfig,
  toPreToolDecision,
}

/**
 * Composed entry. The plugin body:
 *  - subscribes `tools/post-execute` so the ledger records what actually ran;
 *  - subscribes `tools/pre-execute` so the gate is armed on activation;
 *  - waits for the `tools` and `skills` services through `ctx.inject`.
 *
 * Throws only for configuration that cannot be honoured. A missing ledger is
 * never a load failure: it is a `review`.
 */
export function createPlugin(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new PreclaimError(
      ERROR_CODES.BAD_CONTEXT,
      'createPlugin needs a ctx with .on(); the host did not supply one',
    )
  }
  const config = resolveConfig(options)
  const logger = typeof ctx.logger === 'object' && ctx.logger !== null ? ctx.logger : null
  const ledger = createLedger({ limit: config.ledgerLimit })
  const cwd = config.cwd ?? process.cwd()

  // Record first: the gate is only as honest as this ledger.
  ctx.on('tools/post-execute', (payload) => {
    ledger.record(payload)
    return undefined
  })

  ctx.inject(['tools'], (toolCtx) => {
    for (const tool of createTools(config, ledger)) {
      toolCtx.tools.register(tool)
    }
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.register(createSkill(config, ledger))
  })

  ctx.on('tools/pre-execute', createPreExecuteGate(config, ledger, logger, cwd))

  return { config, ledger }
}

export default createPlugin
