/**
 * The session ledger: what actually ran.
 *
 * The gate reads this and nothing else. Two consequences worth stating, because
 * they are the design rather than an implementation detail:
 *
 *  1. **A claim cannot satisfy its own obligation.** The candidate call under
 *     review is never consulted for evidence, so a commit message saying "tests
 *     pass" contributes nothing to its own check.
 *
 *  2. **A failed test run is not evidence that tests pass.** `test-run` requires
 *     success; `ci-check` and `file-read` do not, because observing a red
 *     pipeline is still observing the pipeline, and reading a file is evidence
 *     of reading it whatever the exit code.
 *
 * The ledger holds only what is needed to answer "did this kind of thing run",
 * never full command text for arbitrary tools: a bounded, redacted record is
 * enough, and a transcript of every shell command is not something this plugin
 * should be keeping.
 */
import { EVIDENCE_KINDS } from './constants.mjs'

/** Tool-name fragments that identify a call whose command text we can read. */
const SHELL_HINTS = ['bash', 'shell', 'pwsh', 'powershell', 'zsh', 'sh', 'cmd', 'terminal', 'exec']

/** Tool-name fragments that identify a read, used when there is no command text. */
const READ_HINTS = ['read', 'view', 'cat', 'show', 'glob', 'grep', 'search', 'list']

const MAX_TEXT = 400

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

/**
 * Pull a command string out of a post-execute payload, defensively.
 *
 * The host's payload shape is not something this plugin controls, so every path
 * is optional. Returning '' is the correct answer for "I could not tell" — the
 * caller records no evidence rather than guessing.
 */
export function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const exec = payload.exec && typeof payload.exec === 'object' ? payload.exec : {}
  const args = exec.args && typeof exec.args === 'object' ? exec.args : {}
  const call = payload.call && typeof payload.call === 'object' ? payload.call : {}
  const callExec = call.exec && typeof call.exec === 'object' ? call.exec : {}
  const callArgs = callExec.args && typeof callExec.args === 'object' ? callExec.args : {}
  return firstString(
    exec.command,
    args.command,
    payload.command,
    callExec.command,
    callArgs.command,
    typeof exec.args === 'string' ? exec.args : '',
    typeof callExec.args === 'string' ? callExec.args : '',
  )
}

function extractToolName(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const exec = payload.exec && typeof payload.exec === 'object' ? payload.exec : {}
  const call = payload.call && typeof payload.call === 'object' ? payload.call : {}
  const callExec = call.exec && typeof call.exec === 'object' ? call.exec : {}
  return firstString(payload.toolName, payload.tool, exec.name, call.toolName, callExec.name)
}

/**
 * Did the call succeed?
 *
 * Three answers, not two. `null` means the payload did not say, which is
 * different from "it failed": an obligation that requires success must not be
 * satisfied by a run whose outcome is unknown.
 */
export function extractSuccess(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.ok === 'boolean') return payload.ok
  if (typeof payload.success === 'boolean') return payload.success
  if (payload.error !== undefined && payload.error !== null) return false
  const result = payload.result && typeof payload.result === 'object' ? payload.result : null
  if (result) {
    if (typeof result.ok === 'boolean') return result.ok
    if (typeof result.success === 'boolean') return result.success
    if (typeof result.isError === 'boolean') return !result.isError
    if (result.error !== undefined && result.error !== null) return false
    if (typeof result.exitCode === 'number') return result.exitCode === 0
  }
  if (typeof payload.exitCode === 'number') return payload.exitCode === 0
  return null
}

function isShellTool(toolName) {
  const lowered = String(toolName).toLowerCase()
  return SHELL_HINTS.some((hint) => lowered.includes(hint))
}

function isReadTool(toolName) {
  const lowered = String(toolName).toLowerCase()
  return READ_HINTS.some((hint) => lowered.includes(hint))
}

function redact(text) {
  if (typeof text !== 'string') return ''
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…(${text.length - MAX_TEXT} more)`
}

/**
 * Which evidence kinds does this recorded call provide?
 *
 * Returns the kinds that are *satisfied*, so an unsuccessful test run
 * contributes nothing for `test-run` while still contributing for `file-read`
 * if the tool name says it read something.
 */
export function evidenceFrom(toolName, command, success) {
  const kinds = new Set()
  const text = typeof command === 'string' ? command : ''

  for (const [kind, spec] of Object.entries(EVIDENCE_KINDS)) {
    if (spec.mustSucceed && success !== true) continue
    if (text !== '' && spec.patterns.some((pattern) => pattern.test(text))) {
      kinds.add(kind)
      continue
    }
    // No command text: fall back to the tool name, but only for the read kind.
    // A tool called `bash` with an unreadable command provides no evidence at
    // all — inferring "it probably ran tests" from a tool name would be exactly
    // the kind of guess this plugin exists to avoid.
    if (kind === 'file-read' && text === '' && isReadTool(toolName)) {
      kinds.add(kind)
    }
  }

  // A read-shaped tool that also carried a command is a read regardless.
  if (text !== '' && isReadTool(toolName) && !isShellTool(toolName)) {
    kinds.add('file-read')
  }
  return kinds
}

/**
 * Create the ledger.
 *
 * Not persisted: evidence is a property of *this session*, so a ledger restored
 * from disk would be evidence for a different run. Bounded so a long session
 * cannot grow it without limit.
 */
export function createLedger(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 500
  /** @type {Array<{toolName: string, kinds: string[], success: boolean|null, command: string}>} */
  const entries = []
  let dropped = 0

  return {
    /**
     * Record a completed call. Never throws: a malformed payload must not break
     * the host's post-execute pipeline.
     */
    record(payload) {
      try {
        const toolName = extractToolName(payload)
        const command = extractCommand(payload)
        const success = extractSuccess(payload)
        const kinds = [...evidenceFrom(toolName, command, success)]
        if (kinds.length === 0) return null
        const entry = { toolName, kinds, success, command: redact(command) }
        entries.push(entry)
        while (entries.length > limit) {
          entries.shift()
          dropped += 1
        }
        return entry
      } catch {
        // A ledger that throws would take down the tool pipeline it observes.
        return null
      }
    },

    /** Every recorded evidence kind, in recording order. */
    kinds() {
      const out = []
      for (const entry of entries) out.push(...entry.kinds)
      return out
    },

    /** Does the ledger hold at least one entry of this kind? */
    has(kind) {
      return entries.some((entry) => entry.kinds.includes(kind))
    },

    /** Recorded entries. Returned as a copy so a caller cannot mutate the ledger. */
    snapshot() {
      return entries.map((entry) => ({ ...entry, kinds: entry.kinds.slice() }))
    },

    /** How many entries have aged out. Reported so "empty" is distinguishable. */
    stats() {
      return { size: entries.length, limit, dropped, everRecorded: entries.length + dropped > 0 }
    },

    /** Test seam only. Not called by the plugin. */
    clear() {
      entries.length = 0
      dropped = 0
    },
  }
}
