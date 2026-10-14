/**
 * Configuration resolution.
 *
 * Every key has a documented default, so the shipped `cordis.patch.yml` could be
 * reduced to `enabled: true` and the plugin would still work. Overrides that
 * cannot be honoured throw at load time rather than degrading quietly: a gate
 * that silently stops checking is worse than one that refuses to start.
 */
import {
  DEFAULT_README_GLOBS,
  DEFAULT_TRIGGER_TOOLS,
  LEDGER_LIMIT,
  PUSH_MESSAGE_LIMIT,
} from './constants.mjs'
import { ERROR_CODES, PreclaimError } from './errors.mjs'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value, where) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    throw new PreclaimError(ERROR_CODES.BAD_CONFIG, `${where} must be an array of strings`)
  }
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new PreclaimError(ERROR_CODES.BAD_CONFIG, `${where} entries must be non-empty strings`)
    }
    out.push(entry.trim())
  }
  return out
}

function positiveInt(value, where) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new PreclaimError(
      ERROR_CODES.BAD_CONFIG,
      `${where} must be a positive integer, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * Resolve the effective configuration.
 *
 * Note what is *not* configurable: there is no key that lets an unbacked claim
 * through. `decision` chooses between asking and refusing, and nothing else. A
 * gate with an off switch is a gate that gets switched off.
 */
export function resolveConfig(options = {}) {
  if (!isPlainObject(options)) {
    throw new PreclaimError(ERROR_CODES.BAD_CONFIG, 'options must be an object')
  }

  const triggerTools = asStringArray(options.triggerTools, 'triggerTools')
    ?? DEFAULT_TRIGGER_TOOLS.slice()
  if (triggerTools.length === 0) {
    throw new PreclaimError(
      ERROR_CODES.BAD_CONFIG,
      'triggerTools is empty: a gate that watches nothing checks nothing, so this is refused '
        + 'rather than accepted as a no-op',
    )
  }

  const readmeGlobs = asStringArray(options.readmeGlobs, 'readmeGlobs')
    ?? DEFAULT_README_GLOBS.slice()
  if (readmeGlobs.length === 0) {
    throw new PreclaimError(
      ERROR_CODES.BAD_CONFIG,
      'readmeGlobs is empty: write-shaped actions would never be gated',
    )
  }

  const decision = options.decision ?? 'review'
  if (decision !== 'review' && decision !== 'deny') {
    throw new PreclaimError(
      ERROR_CODES.BAD_CONFIG,
      `decision must be "review" or "deny", got ${JSON.stringify(options.decision)}. `
        + 'There is deliberately no "allow" value: an unbacked claim is never a pass.',
    )
  }

  const ledgerLimit = options.ledgerLimit === undefined
    ? LEDGER_LIMIT
    : positiveInt(options.ledgerLimit, 'ledgerLimit')
  const pushMessageLimit = options.pushMessageLimit === undefined
    ? PUSH_MESSAGE_LIMIT
    : positiveInt(options.pushMessageLimit, 'pushMessageLimit')

  const audit = options.audit ?? true
  if (typeof audit !== 'boolean') {
    throw new PreclaimError(ERROR_CODES.BAD_CONFIG, 'audit must be a boolean')
  }

  const cwd = options.cwd === undefined || options.cwd === null ? null : String(options.cwd)

  return Object.freeze({
    triggerTools,
    readmeGlobs,
    decision,
    ledgerLimit,
    pushMessageLimit,
    audit,
    cwd,
  })
}

/**
 * Exact match, `*` glob, or `*` for everything. Case-insensitive.
 *
 * Escaping with a character class is where this went wrong the first time:
 * `/[.+?^${}()|[\]\\]/g` is not a valid class — the unescaped `[` closes it — so
 * the asterisk was never escaped, the trailing "replace asterisk with dot-star"
 * pass found nothing to replace, and the result was a bare quantifier on the
 * preceding character. Every glob trigger then failed to match, and the gate
 * would have shipped watching nothing while reporting no error.
 */
export function toolMatches(pattern, name) {
  if (pattern === '*') return true
  if (typeof name !== 'string' || name === '') return false
  const subject = name.toLowerCase()
  const needle = String(pattern).toLowerCase()
  if (!needle.includes('*')) return subject === needle
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const source = escaped.replace(/\\\*/g, '.*')
  return new RegExp(`^${source}$`).test(subject)
}
