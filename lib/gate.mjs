/**
 * The `tools/pre-execute` listener.
 *
 * Contract, taken from the host's listener shape and from what a mistake costs:
 *
 *  - the waterfall expects `{kind: 'allow' | 'deny' | 'ask'}` or delegation with
 *    `next()`. It must **not** call `next(err)`: rejecting the waterfall aborts
 *    the pipeline instead of producing a decision.
 *  - `next()` is called exactly once, and only on the allow path.
 *  - a defect in this gate must never become a silent allow. Every unknown path
 *    ends in `ask`, never `allow`.
 *
 * The gate's own decision vocabulary is `allow | review | deny` (the design's
 * words). `review` maps to the host's `ask`.
 */
import { toolMatches } from './config.mjs'
import {
  GATE_DECISIONS,
  REASON_CODES,
  SHELL_TOOL_HINTS,
  WRITE_TOOL_HINTS,
} from './constants.mjs'
import { detectClaims, evidenceFor, evidenceSummary } from './claims.mjs'
import { classifyCommand, stripAnsi } from './shell.mjs'
import { normalisePath } from './paths.mjs'

/** Convert an internal decision into the host's `PreToolDecision`. */
export function toPreToolDecision(result) {
  if (result && result.gate_decision === 'allow') return { kind: 'allow' }
  if (result && result.gate_decision === 'deny') {
    return {
      kind: 'deny',
      reason: `dsh-preclaim: ${result.gate_reason_code}`,
      displayReason: result.gate_message,
    }
  }
  const message = result && typeof result.gate_message === 'string' && result.gate_message !== ''
    ? result.gate_message
    : 'the gate produced a result it could not interpret'
  return { kind: 'ask', reason: `dsh-preclaim: ${message}`, displayReason: message }
}

function isShellTool(toolName) {
  const lowered = String(toolName).toLowerCase()
  return SHELL_TOOL_HINTS.some((hint) => lowered.includes(hint))
}

function isWriteTool(toolName) {
  const lowered = String(toolName).toLowerCase()
  return WRITE_TOOL_HINTS.some((hint) => lowered.includes(hint))
}

/** Read the arguments object out of whichever shape the host used. */
export function extractArgs(payload) {
  if (!payload || typeof payload !== 'object') return {}
  const exec = payload.exec && typeof payload.exec === 'object' ? payload.exec : {}
  const call = payload.call && typeof payload.call === 'object' ? payload.call : {}
  const callExec = call.exec && typeof call.exec === 'object' ? call.exec : {}
  for (const value of [exec.args, callExec.args, payload.args]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return {}
}

/** Read the tool name out of whichever shape the host used. */
export function extractToolName(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const exec = payload.exec && typeof payload.exec === 'object' ? payload.exec : {}
  const call = payload.call && typeof payload.call === 'object' ? payload.call : {}
  const callExec = call.exec && typeof call.exec === 'object' ? call.exec : {}
  for (const value of [payload.toolName, payload.tool, exec.name, call.toolName, callExec.name]) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function bounded(text, limit = 8000) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(0, limit)
}

/**
 * Is this call one the gate watches?
 *
 * Either the tool name is on the list, or the command hits a triggering git verb.
 * Both, because host tool names are version-dependent while a `git commit` inside
 * a `pwsh` call is not.
 */
export function isTriggered(config, toolName, command) {
  if (config.triggerTools.some((pattern) => toolMatches(pattern, toolName))) return true
  if (command !== '') {
    return classifyCommand(command).some((entry) => entry.assertion)
  }
  return false
}

/**
 * Work out what a call asserts.
 *
 * Returns the claim text, the claims found in it, and enough provenance for a
 * reader to see where the text came from. Returns `{ claimText: null }` when the
 * call is in scope but carries nothing readable — which is the caller's cue to
 * allow, since an unreadable non-claim is not a claim.
 */
export function analyseAction(config, toolName, payload, cwd) {
  const args = extractArgs(payload)
  const detail = { source: null, segments: [], path: null, outsideCwd: false }

  if (isShellTool(toolName)) {
    const command = stripAnsi(typeof args.command === 'string' ? args.command : '')
    if (command === '') return { claimText: null, detail }
    let segments
    try {
      segments = classifyCommand(command)
    } catch {
      // A parser failure on the command text is not a reason to allow: treat the
      // whole command as the candidate text and let claim detection decide.
      segments = []
    }
    detail.segments = segments.map((entry) => ({
      segment: entry.segment,
      assertion: entry.assertion,
      kind: entry.kind ?? null,
      reason: entry.reason ?? null,
    }))
    const asserting = segments.filter((entry) => entry.assertion)
    if (asserting.length === 0) return { claimText: null, detail }

    const messages = []
    let limitHit = false
    for (const entry of asserting) {
      if (entry.kind === 'git_commit') {
        for (const message of entry.messages) messages.push(message)
      }
    }
    if (messages.length > config.pushMessageLimit) {
      limitHit = true
    }
    const text = messages.length > 0
      ? messages.join('\n')
      // A push or tag asserts through the commits it carries, which this layer
      // cannot read. The command text itself is the only thing available, and
      // checking it is better than checking nothing.
      : asserting.map((entry) => entry.segment).join('\n')
    detail.source = 'command'
    detail.limitHit = limitHit
    return { claimText: bounded(text), detail }
  }

  if (isWriteTool(toolName)) {
    const raw = args.file_path ?? args.path ?? args.filename
    if (typeof raw !== 'string' || raw.trim() === '') return { claimText: null, detail }
    const normalised = normalisePath(raw, cwd)
    detail.path = normalised.relative
    if (!normalised.insideCwd) {
      detail.outsideCwd = true
      return { claimText: null, detail }
    }
    if (!matchesGlobs(normalised.relative, config.readmeGlobs)) {
      return { claimText: null, detail }
    }
    const content = args.content ?? args.new_string ?? args.new_str ?? args.text
    if (typeof content !== 'string' || content.trim() === '') return { claimText: null, detail }
    detail.source = 'file-content'
    return { claimText: bounded(content), detail }
  }

  return { claimText: null, detail }
}

/**
 * Glob match for repository-relative paths.
 *
 * `**` crosses directories, `*` does not. Case-insensitive throughout: the
 * design calls this out for Windows, and a gate that matches `README.md` on Linux
 * but not on Windows is worse than one that matches neither.
 */
export function matchesGlobs(relativePath, globs) {
  const path = String(relativePath).replace(/\\/g, '/').toLowerCase()
  const base = path.split('/').pop() ?? ''
  return globs.some((glob) => globToRegExp(glob).test(path) || globToRegExp(glob).test(base))
}

const globCache = new Map()

/**
 * Translate a glob to a RegExp.
 *
 * The two starred forms are substituted in **one** pass via a callback, not in
 * successive `replace` calls. Successive calls are a trap that produced a real
 * bug here: `**` became `.*`, and the following rule for `*` then matched the
 * `*` **inside** that freshly written `.*` and turned it into `.[^/]*`. The
 * result was that `docs/**` / `*.md` matched nothing — silently, because a glob
 * that matches nothing looks exactly like a path outside its scope.
 *
 * One pass, longest token first, and nothing written by an earlier substitution
 * can be seen by a later one.
 */
function globToRegExp(glob) {
  const key = String(glob).toLowerCase()
  const cached = globCache.get(key)
  if (cached) return cached
  const escaped = key.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const source = escaped.replace(/\*\*\/|\*\*|\*|\?/g, (token) => {
    if (token === '**/') return '(?:.*/)?'
    if (token === '**') return '.*'
    if (token === '*') return '[^/]*'
    return '[^/]'
  })
  const re = new RegExp(`^${source}$`)
  globCache.set(key, re)
  return re
}

/**
 * Decide one call.
 *
 * The full result shape is the design's, so a caller can read the same fields
 * whatever tier produced the answer. `model_verdict` and `model_calls` are
 * present and honest: this tier never calls a model.
 */
export function decideCall(config, ledger, toolName, payload, cwd = process.cwd()) {
  const base = {
    gate_decision: 'allow',
    gate_reason_code: REASON_CODES.NOT_TRIGGERED,
    gate_message: 'not an action this gate watches',
    claims: [],
    evidence_summary: evidenceSummary(ledger),
    missing_evidence: [],
    model_verdict: null,
    model_calls: 0,
    detail: {},
  }

  const action = analyseAction(config, toolName, payload, cwd)
  base.detail = action.detail

  if (!isTriggered(config, toolName, detailCommand(action))) {
    return base
  }

  if (action.claimText === null) {
    return {
      ...base,
      gate_reason_code: REASON_CODES.NO_CLAIM,
      gate_message: action.detail.outsideCwd
        ? 'the target path is outside the working directory, so this gate does not judge it'
        : 'this action carries no claim a session record could confirm',
    }
  }

  const claims = detectClaims(action.claimText)
  if (claims.length === 0) {
    return {
      ...base,
      gate_reason_code: REASON_CODES.NO_CLAIM,
      gate_message: 'this action carries no claim a session record could confirm',
    }
  }

  const answers = evidenceFor(claims, ledger)
  const satisfied = answers.filter((answer) => answer.satisfied)
  const unsatisfied = answers.filter((answer) => !answer.satisfied)

  base.claims = answers
  base.missing_evidence = unsatisfied.flatMap((answer) => answer.evidenceKinds)

  if (unsatisfied.length === 0) {
    return {
      ...base,
      gate_reason_code: REASON_CODES.EVIDENCE_PRESENT,
      gate_message: `every claim is backed by recorded evidence (${satisfied.map((a) => a.id).join(', ')})`,
      model_verdict: 'evidence_present',
    }
  }

  // A claim nothing observable could answer is a limit of this gate, not a lie.
  // Where *every* unsatisfied claim is of that sort, saying "unbacked" would be
  // an accusation the gate cannot support.
  const answerable = unsatisfied.filter((answer) => answer.answerable)
  if (answerable.length === 0) {
    return {
      ...base,
      gate_decision: 'review',
      gate_reason_code: REASON_CODES.TOOL_UNVERIFIED,
      gate_message: `this action asserts ${unsatisfied.map((a) => a.id).join(', ')}, which no `
        + 'evidence this gate can observe would confirm — it needs a human, not a verdict',
      model_verdict: 'tool_unverified',
    }
  }

  const stats = ledger.stats()
  const unknowable = !stats.everRecorded
  return {
    ...base,
    gate_decision: config.decision,
    gate_reason_code: unknowable ? REASON_CODES.LEDGER_EMPTY : REASON_CODES.CLAIM_UNBACKED,
    gate_message: unknowable
      ? 'this session has recorded no evidence at all, so this gate cannot tell "it did not '
        + `happen" from "I did not see it" — asserted: ${answerable.map((a) => a.id).join(', ')}`
      : `the action asserts ${answerable.map((a) => a.id).join(', ')}, and this session has no `
        + `record of: ${[...new Set(answerable.flatMap((a) => a.evidenceKinds))].join(', ')}`,
    model_verdict: 'claim_unbacked',
    uncertain: unknowable,
  }
}

function detailCommand(action) {
  return action?.detail?.source === 'command'
    ? action.detail.segments.map((entry) => entry.segment).join('\n')
    : ''
}

/**
 * Build the listener.
 *
 * `next()` is called exactly once, on the allow path. Every other path returns a
 * decision, so an `ask` can never become a pass by falling off the end.
 */
export function createPreExecuteGate(config, ledger, logger = null, cwd = process.cwd()) {
  return function preExecute(payload, next) {
    let result
    try {
      const toolName = extractToolName(payload)
      if (toolName === '') {
        const verdict = {
          kind: 'ask',
          reason: 'dsh-preclaim: the tools/pre-execute payload carried no usable tool name, '
            + 'so this call could not be checked',
        }
        if (config.audit && logger && typeof logger.warn === 'function') logger.warn(verdict.reason)
        return verdict
      }
      result = decideCall(config, ledger, toolName, payload, cwd)
    } catch (error) {
      // A defect here must not become a silent allow.
      const reason = `dsh-preclaim: the gate failed (${error && error.message ? error.message : error})`
      if (config.audit && logger && typeof logger.warn === 'function') logger.warn(reason)
      return { kind: 'ask', reason }
    }

    if (config.audit && logger && typeof logger.info === 'function') {
      logger.info(`dsh-preclaim: ${result.gate_decision} (${result.gate_reason_code})`)
    }
    if (result.gate_decision === 'allow') return next()
    return toPreToolDecision(result)
  }
}

export { GATE_DECISIONS }
