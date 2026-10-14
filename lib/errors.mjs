/**
 * Error codes and the error type.
 *
 * A small vocabulary, because each one is a distinct thing a reader might
 * respond to differently. Configuration that cannot be honoured throws;
 * everything about the candidate action is a verdict, not an exception.
 */
export const ERROR_CODES = Object.freeze({
  BAD_CONTEXT: 'PRECLAIM_BAD_CONTEXT',
  BAD_CONFIG: 'PRECLAIM_BAD_CONFIG',
  BAD_PATTERN: 'PRECLAIM_BAD_PATTERN',
})

export class PreclaimError extends Error {
  constructor(code, message, detail = null) {
    super(`${code}: ${message}`)
    this.name = 'PreclaimError'
    this.code = code
    this.detail = detail
  }
}
