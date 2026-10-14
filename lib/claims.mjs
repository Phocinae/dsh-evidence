/**
 * Claim detection and the answers to claims.
 *
 * Two questions, kept apart on purpose:
 *
 *  - `detectClaims(text)` — does this text assert anything a session record could
 *    confirm or contradict? This is a fact about the text.
 *  - `evidenceFor(claims, ledger)` — does this session have the record that would
 *    answer those claims? This is a fact about the session.
 *
 * The gate's verdict is the comparison. Keeping the two apart is what stops the
 * text under review from ever counting as its own evidence.
 */
import { CLAIM_KIND_EVIDENCE, CLAIM_PATTERNS } from './constants.mjs'
import { stripAnsi } from './shell.mjs'

/**
 * Which claim patterns does this text match?
 *
 * Returns one entry per matching pattern, with the matched text so a human can
 * see what was read as a claim. ANSI is stripped first: an escape sequence in the
 * middle of a phrase would otherwise defeat every pattern.
 */
export function detectClaims(text) {
  const subject = stripAnsi(typeof text === 'string' ? text : '')
  if (subject.trim() === '') return []
  const hits = []
  for (const pattern of CLAIM_PATTERNS) {
    const match = subject.match(pattern.re)
    if (match) {
      hits.push({
        id: pattern.id,
        kind: pattern.kind,
        describes: pattern.describes,
        matched: match[0].length > 120 ? `${match[0].slice(0, 120)}…` : match[0],
      })
    }
  }
  return hits
}

/**
 * For each claim, which evidence kinds would answer it, and does the ledger have
 * any of them?
 *
 * A claim kind mapped to `[]` is one this plugin cannot answer at all. That is
 * recorded as such rather than folded into "missing", because "this session has
 * no test run" and "nothing observable could ever confirm this" call for
 * different responses: the first is a gap, the second is a limit.
 */
export function evidenceFor(claims, ledger) {
  const answers = []
  for (const claim of claims) {
    const kinds = CLAIM_KIND_EVIDENCE[claim.kind] ?? []
    const present = kinds.filter((kind) => ledger.has(kind))
    answers.push({
      id: claim.id,
      kind: claim.kind,
      describes: claim.describes,
      matched: claim.matched,
      answerable: kinds.length > 0,
      evidenceKinds: kinds,
      satisfiedBy: present,
      satisfied: kinds.length > 0 && present.length > 0,
    })
  }
  return answers
}

/**
 * Summarise the session's recorded evidence, deduplicated by kind.
 *
 * The `ref` is the first recorded command of that kind, truncated. It is there so
 * a human reading a stop can see *what* the gate counted, rather than being told
 * that something was or was not recorded.
 */
export function evidenceSummary(ledger) {
  const byKind = new Map()
  for (const entry of ledger.snapshot()) {
    for (const kind of entry.kinds) {
      if (!byKind.has(kind)) {
        byKind.set(kind, {
          kind,
          ref: entry.command === '' ? entry.toolName : entry.command,
          success: entry.success,
        })
      }
    }
  }
  return [...byKind.values()]
}
