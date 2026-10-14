/**
 * Shell command analysis — deterministic, string only, no process spawning.
 *
 * Two steps here are load-bearing and easy to leave out:
 *
 *  1. **ANSI stripping.** Real captured output can carry escape sequences even
 *     when piped, so `--version` can arrive as `\u001b[1;33m--version\u001b[0m`.
 *     Every plain-text pattern then fails to match, and the gate silently stops
 *     recognising the very commands it exists to inspect. Stripping is not an
 *     optimisation.
 *  2. **Quote-aware splitting.** Splitting on `;` alone cuts `git commit -m "a; b"`
 *     in half, and the half that survives no longer looks like a commit — so a
 *     claim inside a message would be missed. Operators inside quotes are text.
 */
import {
  ANSI_RE,
  GIT_ASSERTING_VERBS,
  GIT_READING_VERBS,
  NON_ASSERTING_FLAGS,
} from './constants.mjs'

/** Remove ANSI escape sequences. */
export function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : ''
}

/**
 * Split a command line on shell operators that are **not** inside quotes.
 *
 * Handles single quotes, double quotes and backslash escapes. An unterminated
 * quote is treated as running to end of input, which is the shell's own reading
 * and the safe one here: treating the rest as a quoted blob means at worst we
 * miss a claim, never that we invent a command that was not there.
 */
export function splitSegments(command) {
  const text = stripAnsi(command)
  const out = []
  let current = ''
  let quote = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (ch === '\\' && quote !== "'" && i + 1 < text.length) {
      current += ch + text[i + 1]
      i += 1
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '\n') {
      out.push(current)
      current = ''
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      // `&&` and `||` are one operator; a lone `&` backgrounds.
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i += 1
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((segment) => segment.trim()).filter((segment) => segment !== '')
}

/** Tokenise a single segment, respecting quotes. */
export function tokenize(segment) {
  const out = []
  let current = ''
  let quote = null
  let started = false

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]
    if (ch === '\\' && quote !== "'" && i + 1 < segment.length) {
      current += segment[i + 1]
      i += 1
      started = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/** Strip leading `env` and `VAR=value` assignments from a segment. */
function stripEnvironment(tokens) {
  let index = 0
  if (tokens[index] === 'env') index += 1
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1
  return tokens.slice(index)
}

/**
 * Split a segment's tokens into the argument list of the **last** command in a
 * pipeline segment, which is what a claim would be attached to.
 */
function afterLeadingShell(tokens) {
  let list = stripEnvironment(tokens)
  // `cd x && git commit ...` arrives here already split on `&&`, so no handling
  // is needed for that. Wrappers like `sudo` / `command` are.
  while (list.length > 0 && ['sudo', 'command', 'nohup', 'time', 'exec'].includes(list[0])) {
    list = list.slice(1)
  }
  return list
}

function readMessageArgs(tokens, from) {
  const messages = []
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '-m' || token === '--message') {
      if (i + 1 < tokens.length) {
        messages.push(tokens[i + 1])
        i += 1
      }
      continue
    }
    if (token.startsWith('--message=')) {
      messages.push(token.slice('--message='.length))
      continue
    }
    if (token.startsWith('-m') && token.length > 2) {
      messages.push(token.slice(2))
    }
  }
  return messages
}

/**
 * Classify one command segment.
 *
 * Returns `{ assertion: true, kind, gitVerb, messages, cwd }` when the segment
 * carries something a session record could confirm, and `{ assertion: false }`
 * otherwise. `kind` is `'git_commit'`, `'git_push'` or `'git_tag'`.
 */
export function classifySegment(segment) {
  const tokens = afterLeadingShell(tokenize(segment))
  if (tokens.length === 0) return { assertion: false, reason: 'empty' }

  if (tokens[0] !== 'git') return { assertion: false, reason: 'not-git' }

  // Flags that mean nothing is written.
  for (const token of tokens.slice(1)) {
    if (NON_ASSERTING_FLAGS.includes(token)) {
      return { assertion: false, reason: `non-asserting-flag:${token}` }
    }
  }

  // Find the verb: the first token after `git` that is not an option, taking
  // `-C <path>` out as a working directory rather than treating it as one.
  let cwd = null
  let verb = null
  let verbIndex = -1
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '-C') {
      if (i + 1 < tokens.length) {
        cwd = tokens[i + 1]
        i += 1
      }
      continue
    }
    if (token.startsWith('-C') && token.length > 2) {
      cwd = token.slice(2)
      continue
    }
    if (token.startsWith('-')) continue
    verb = token
    verbIndex = i
    break
  }

  if (verb === null) return { assertion: false, reason: 'no-verb' }
  if (GIT_READING_VERBS.includes(verb)) return { assertion: false, reason: `read-only-verb:${verb}` }
  if (!GIT_ASSERTING_VERBS.includes(verb)) return { assertion: false, reason: `unknown-verb:${verb}` }

  const kind = `git_${verb}`
  const rest = tokens.slice(verbIndex + 1)
  return {
    assertion: true,
    kind,
    gitVerb: verb,
    cwd,
    // A commit carries its message inline. `push` and `tag` carry theirs in the
    // commits they cover, which this layer cannot see; that is the caller's job
    // and the design says so.
    messages: verb === 'commit' ? readMessageArgs(tokens, verbIndex + 1) : [],
    tokens: rest,
  }
}

/** Classify every segment of a command. */
export function classifyCommand(command) {
  return splitSegments(command).map((segment) => ({
    segment,
    ...classifySegment(segment),
  }))
}

/** Does this command contain at least one asserting git action? */
export function commandAsserts(command) {
  return classifyCommand(command).some((entry) => entry.assertion)
}
