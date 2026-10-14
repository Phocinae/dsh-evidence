/**
 * Shipped defaults and the fixed vocabularies.
 *
 * Source of truth for the shapes here is the project's own design document
 * (`_work/design/dsh-evidence.md`, §2.3 and §1.1), not invention. Where this file
 * departs from that document it says so in a comment, because a silent departure
 * is how a design and an implementation quietly stop describing the same thing.
 *
 * Two decisions worth stating up front:
 *
 *  1. **The plugin fails closed on a triggered action it cannot judge, and open on
 *     an action that carries no claim.** Those are different things. "This is not
 *     a claim" is a fact about the action; "I cannot tell whether this is backed"
 *     is ignorance about the session. Only the second one is a reason to stop.
 *  2. **`allow` is never the answer to ignorance.** Every unknown path ends in
 *     `review` (or `deny`), never in `allow`.
 */

export const LEDGER_LIMIT = 500

/** Gate decisions. `review` means "a human should look", not "probably fine". */
export const GATE_DECISIONS = Object.freeze(['allow', 'review', 'deny'])

/**
 * Why the gate decided. Stable strings: they appear in output and in tests.
 */
export const REASON_CODES = Object.freeze({
  NOT_TRIGGERED: 'not-a-triggered-tool',
  NO_CLAIM: 'no-claim-in-action',
  EVIDENCE_PRESENT: 'evidence-present',
  CLAIM_UNBACKED: 'claim-unbacked',
  TOOL_UNVERIFIED: 'tool-unverified',
  LEDGER_EMPTY: 'ledger-empty-so-unknowable',
  NO_TOOL_NAME: 'payload-had-no-tool-name',
  GATE_ERROR: 'gate-error',
})

/**
 * Tools the gate watches.
 *
 * All five names were verified to exist on a real host, so none of these is a
 * guess: `read` / `write` / `edit` / `read_image` come from `dsh-tool-fs`,
 * `pwsh` from `dsh-tool-pwsh`, `bash` from `dsh-tool-bash`, and
 * `str_replace_editor` from `dsh-tool-str-replace-editor`.
 *
 * A tool that is not on this list is not gated at all. That is the one place
 * where "no match" means "allow", and the reason is that a non-matching tool
 * carries no claim to check rather than an unjudgeable one.
 */
export const DEFAULT_TRIGGER_TOOLS = Object.freeze([
  'pwsh',
  'bash',
  'write',
  'edit',
  'str_replace_editor',
])

/**
 * Paths whose content is treated as an assertion surface.
 *
 * The design calls for "README-shaped writes" to be gated, because a README is
 * where a project states what it does and whether it works. Ordinary source
 * writes are left alone: gating those would put a gate in front of every edit.
 */
export const DEFAULT_README_GLOBS = Object.freeze([
  'README*',
  'CHANGELOG*',
  'docs/**/*.md',
  '**/README.md',
])

/** Git verbs that assert something was done. */
export const GIT_ASSERTING_VERBS = Object.freeze(['commit', 'push', 'tag'])

/** Git verbs that only read. Never gated, whatever the arguments say. */
export const GIT_READING_VERBS = Object.freeze([
  'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'remote',
  'describe', 'blame', 'config', 'shortlog', 'fetch', 'stash', 'rev-list',
  'cat-file', 'for-each-ref', 'symbolic-ref', 'check-ignore', 'grep',
])

/**
 * Flags that mean the command does not write anything.
 *
 * `git push --dry-run` makes no durable claim, so gating it would be noise.
 * Applied per command segment, so `git fetch && git commit -m x` still gates the
 * commit.
 */
export const NON_ASSERTING_FLAGS = Object.freeze(['--dry-run', '--help', '-h', '--version'])

/**
 * Claim patterns, from the design's `CLAIM_PATTERNS` table.
 *
 * These are deliberately syntactic rather than semantic. The gate's question is
 * narrow — "does this action assert something a session record could confirm or
 * contradict" — and a pattern either answers that or it does not. A wider net
 * here means more false stops on honest work, and a gate that cries wolf gets
 * switched off.
 *
 * `kind` groups patterns by what evidence would answer them, which is what lets
 * one obligation table serve every pattern.
 */
export const CLAIM_PATTERNS = Object.freeze([
  {
    id: 'CLAIM_TEST_PASSED',
    kind: 'test',
    re: /\b(tests?|specs?)\b[^.\n]{0,40}\b(pass|passes|passing|passed|green|all green)\b|全部通过|测试通过|检查通过/i,
    describes: 'says tests pass',
  },
  {
    id: 'CLAIM_VERIFIED',
    kind: 'verify',
    re: /\b(verified|validated|confirmed|reproduced|checked)\b|已(?:验证|核实|复现|确认|核对)/i,
    describes: 'says something was verified',
  },
  {
    id: 'CLAIM_RAN_CHECK',
    kind: 'test',
    re: /\b(ran|runs|executed|invoked)\b[^.\n]{0,30}\b(check|test|suite|lint|gate|battery)\b|跑(?:了|过)|已运行/i,
    describes: 'says a check was run',
  },
  {
    id: 'CLAIM_BUILD_OK',
    kind: 'build',
    re: /\bbuild\b[^.\n]{0,20}\b(succeeds?|succeeded|ok|green)\b|构建(?:成功|通过)/i,
    describes: 'says the build succeeds',
  },
  {
    id: 'CLAIM_CLI_ASSERTION',
    kind: 'cli',
    re: /--[a-z][a-z0-9-]{1,30}\b|\bnpm run [a-z][a-z0-9:-]{1,30}\b|\bphocinae-\w+ \w+/,
    describes: 'names a CLI invocation',
  },
  {
    id: 'CLAIM_DEPENDENCY',
    kind: 'platform',
    re: /\b(windows|linux|posix|macos)[- ](only|specific|dependent)\b|依赖\s*(?:Windows|Linux|POSIX)|只(?:在|支持)\s*(?:Windows|Linux)/i,
    describes: 'asserts a platform dependency',
  },
  {
    id: 'CLAIM_LINE_REF',
    kind: 'line',
    re: /\b(?:L|line\s?)(\d{1,6})\b|第\s?(\d{1,6})\s?行/,
    describes: 'cites a line',
  },
  {
    id: 'CLAIM_COUNT',
    kind: 'count',
    re: /\b(\d{1,6})\s*(?:个|条|项|cases?|tests?|items?|files?)\b|\b(\d{1,6})\s*\/\s*(\d{1,6})\b/i,
    describes: 'cites a count',
  },
  {
    id: 'CLAIM_HASH_REF',
    kind: 'hash',
    re: /\b[0-9a-f]{7,40}\b/,
    describes: 'cites a commit hash',
  },
  {
    id: 'CLAIM_FILE_EXISTS',
    kind: 'file',
    re: /`[^`\n]{1,120}\.(?:py|mjs|js|ts|json|ya?ml|md|toml|cfg|ini|sh|ps1)`|(?:文件|file)\s*`?[\w./-]{1,80}\.(?:py|mjs|js|ts|json|ya?ml|md)/i,
    describes: 'cites a file',
  },
])

/**
 * What evidence answers each claim kind.
 *
 * `test` is answered by a recorded test run. `verify` and `line` are answered by
 * having read something. The rest are answered by nothing this plugin can
 * observe, and they are listed explicitly rather than left out, because
 * "unanswered by design" and "I forgot to add it" look identical in a diff.
 */
export const CLAIM_KIND_EVIDENCE = Object.freeze({
  test: ['test-run'],
  verify: ['test-run', 'ci-check', 'file-read'],
  build: ['build-run'],
  cli: [],
  platform: [],
  line: ['file-read'],
  count: [],
  hash: [],
  file: ['file-read'],
})

/**
 * Commands that count as evidence once they are recorded.
 *
 * Matched against what actually ran, never against the action being checked —
 * that separation is what stops a commit message from satisfying its own
 * obligation.
 *
 * `mustSucceed` is the subtle field. A test run that **failed** is not evidence
 * that tests pass; counting it would make the gate actively misleading, which is
 * worse than not having it. Observing a red pipeline is still observing CI, and
 * reading a file is evidence of reading it whatever the exit code.
 */
export const EVIDENCE_KINDS = Object.freeze({
  'test-run': {
    mustSucceed: true,
    patterns: [
      /(^|[\s;&|])pytest(\s|$)/i,
      /(^|[\s;&|])python3?\s+-m\s+(pytest|unittest)(\s|$)/i,
      /(^|[\s;&|])npm\s+(run\s+)?test(\s|$)/i,
      /(^|[\s;&|])pnpm\s+(run\s+)?test(\s|$)/i,
      /(^|[\s;&|])yarn\s+test(\s|$)/i,
      /(^|[\s;&|])go\s+test(\s|$)/i,
      /(^|[\s;&|])cargo\s+test(\s|$)/i,
      /(^|[\s;&|])make\s+test(\s|$)/i,
      /(^|[\s;&|])dotnet\s+test(\s|$)/i,
      /(^|[\s;&|])mvn\s+test(\s|$)/i,
      /(^|[\s;&|])gradle(w)?\s+test(\s|$)/i,
      /(^|[\s;&|])node\s+--test(\s|$)/i,
      /(^|[\s;&|])bun\s+test(\s|$)/i,
    ],
  },
  'build-run': {
    mustSucceed: true,
    patterns: [
      /(^|[\s;&|])(npm|pnpm|yarn)\s+(run\s+)?build(\s|$)/i,
      /(^|[\s;&|])cargo\s+build(\s|$)/i,
      /(^|[\s;&|])go\s+build(\s|$)/i,
      /(^|[\s;&|])dotnet\s+build(\s|$)/i,
      /(^|[\s;&|])mvn\s+(package|install)(\s|$)/i,
      /(^|[\s;&|])gradle(w)?\s+build(\s|$)/i,
      /(^|[\s;&|])python3?\s+-m\s+build(\s|$)/i,
    ],
  },
  'ci-check': {
    mustSucceed: false,
    patterns: [
      /(^|[\s;&|])gh\s+(run|pr|workflow)\s+(view|list|watch|checks)(\s|$)/i,
      /(^|[\s;&|])gh\s+api(\s|$)/i,
    ],
  },
  'file-read': {
    mustSucceed: false,
    patterns: [
      /(^|[\s;&|])(cat|bat|less|more|head|tail)(\s|$)/i,
      /(^|[\s;&|])(rg|grep|Select-String)(\s|$)/i,
      /(^|[\s;&|])(Get-Content|Get-ChildItem|Test-Path|Select-Object)(\s|$)/i,
      /(^|[\s;&|])(sed|awk)(\s|$)/i,
      /(^|[\s;&|])git\s+(diff|show|log)(\s|$)/i,
    ],
  },
})

/** Tool-name fragments identifying a read-shaped tool. */
export const READ_TOOL_HINTS = Object.freeze(['read', 'view', 'cat', 'show', 'glob', 'grep', 'search', 'list'])

/** Tool-name fragments identifying a shell-shaped tool. */
export const SHELL_TOOL_HINTS = Object.freeze([
  'bash', 'shell', 'pwsh', 'powershell', 'zsh', 'sh', 'cmd', 'terminal', 'exec',
])

/** Tool-name fragments identifying a write-shaped tool. */
export const WRITE_TOOL_HINTS = Object.freeze(['write', 'edit', 'str_replace', 'replace', 'create'])

/**
 * Cap on how many commit messages a push is checked against.
 *
 * A push covers every commit not yet on the remote, which in the worst case is
 * the whole history. Checking all of it would make the gate's cost depend on
 * repository age, so the design caps it. The cap is reported in the output when
 * it bites, because a silently truncated check reads as a complete one.
 */
export const PUSH_MESSAGE_LIMIT = 20

/** ANSI escape sequences. */
export const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g
