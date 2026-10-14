/**
 * Tool definitions registered on `ctx.tools`.
 *
 * Hand-built `ToolDefinition` objects rather than a builder's output, so the
 * plugin has no run-time dependency on the harness's tool helpers. Two schema
 * facts the registry enforces, learned by registering against a real host:
 *
 *  - the model-facing field is `parameters` (raw JSON Schema), not `inputSchema`;
 *  - both `parameters` and `output.schema` must stay inside the harness's
 *    enforced JSON Schema subset: one scalar `type` per node, `required` as an
 *    array of names, and no author-only keywords such as a per-property
 *    `required: true`.
 */
import { detectClaims, evidenceFor, evidenceSummary } from './lib/claims.mjs'
import { CLAIM_PATTERNS, REASON_CODES } from './lib/constants.mjs'

const CLAIM_ENTRY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    describes: { type: 'string' },
    matched: { type: 'string' },
    answerable: { type: 'boolean' },
    satisfied: { type: 'boolean' },
    evidenceKinds: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'kind', 'describes', 'matched', 'answerable', 'satisfied'],
}

const STATUS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description:
        'The text you are about to commit, push, or write into a README. The tool reports '
        + 'which claims that text makes and whether this session has the evidence for them — '
        + 'the same check the gate runs, without performing the action.',
    },
  },
  required: [],
}

const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ledger: {
      type: 'object',
      additionalProperties: false,
      properties: {
        size: { type: 'number' },
        limit: { type: 'number' },
        dropped: { type: 'number' },
        everRecorded: { type: 'boolean' },
      },
      required: ['size', 'limit', 'dropped', 'everRecorded'],
    },
    evidence: { type: 'array', items: { type: 'string' } },
    claims: { type: 'array', items: CLAIM_ENTRY },
    missingEvidence: { type: 'array', items: { type: 'string' } },
    wouldDecide: { type: 'string' },
    wouldReason: { type: 'string' },
  },
  required: ['ledger', 'evidence', 'claims', 'missingEvidence', 'wouldDecide', 'wouldReason'],
}

/**
 * Build the tool list.
 *
 * @param config resolved configuration
 * @param ledger the session ledger
 */
export function createTools(config, ledger) {
  return [
    {
      name: 'evidence_status',
      description:
        'Report what evidence this session has actually recorded, and — for a given text — '
        + 'which claims that text makes and whether the evidence exists. Use it before a '
        + 'commit, push, or README write that asserts something was verified or that tests '
        + 'pass. It reads the session ledger only: it does not inspect the transcript, does '
        + 'not call a model, and does not guess.',
      parameters: STATUS_PARAMETERS,
      output: { schema: STATUS_OUTPUT },
      async execute(input = {}) {
        const stats = ledger.stats()
        const summary = evidenceSummary(ledger)
        const evidence = summary.map((entry) => entry.kind).sort()

        const text = typeof input.text === 'string' ? input.text : ''
        const detected = text.trim() === '' ? [] : detectClaims(text)
        const claims = detected.length === 0 ? [] : evidenceFor(detected, ledger)
        const missingEvidence = [...new Set(
          claims.filter((claim) => !claim.satisfied).flatMap((claim) => claim.evidenceKinds),
        )]

        let wouldDecide = 'allow'
        let wouldReason = 'this text makes no claim a session record could confirm'
        if (claims.length > 0) {
          const unsatisfied = claims.filter((claim) => !claim.satisfied)
          if (unsatisfied.length === 0) {
            wouldDecide = 'allow'
            wouldReason = `every claim is backed by recorded evidence (${claims.map((c) => c.id).join(', ')})`
          } else if (unsatisfied.every((claim) => !claim.answerable)) {
            wouldDecide = 'review'
            wouldReason = `this text asserts ${unsatisfied.map((c) => c.id).join(', ')}, which no `
              + 'evidence this gate can observe would confirm — it needs a human, not a verdict'
          } else {
            wouldDecide = config.decision
            wouldReason = stats.everRecorded
              ? `this session has no record of: ${missingEvidence.join(', ')}`
              : 'this session has recorded no evidence at all, so an unmet claim cannot be '
                + 'told apart from an unobserved one'
          }
        }

        // Exactly the declared keys: the schema says additionalProperties:false.
        return {
          ledger: { ...stats },
          evidence,
          claims,
          missingEvidence,
          wouldDecide,
          wouldReason,
        }
      },
    },
  ]
}

/** Names this plugin registers, for tests and for a host's diffing. */
export const TOOL_NAMES = Object.freeze(['evidence_status'])

/** Exported so a test can assert the tool and the gate share one pattern table. */
export const PATTERN_IDS = Object.freeze(CLAIM_PATTERNS.map((pattern) => pattern.id))

export { REASON_CODES }
