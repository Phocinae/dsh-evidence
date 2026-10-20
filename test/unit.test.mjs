/**
 * Test suite for dsh-preclaim.
 *
 * No host, no network, no model. The assertions that matter most, because each
 * one is a way the gate could be *silently* useless rather than visibly broken:
 *
 *  - the trigger actually fires on a `git commit` inside a `pwsh` call;
 *  - a claim cannot satisfy its own obligation;
 *  - a failed test run is not evidence that tests pass;
 *  - ANSI escapes do not defeat claim detection;
 *  - a quoted `;` does not split a commit message in half;
 *  - `next()` is called exactly once, and only on the allow path;
 *  - an empty ledger asks, never allows and never denies on a factual basis;
 *  - a throw inside the gate becomes `ask`, never `allow`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig, toolMatches } from '../lib/config.mjs'
import { ERROR_CODES, PreclaimError } from '../lib/errors.mjs'
import { createLedger, evidenceFrom, extractCommand, extractSuccess } from '../lib/ledger.mjs'
import { createPreExecuteGate, decideCall, matchesGlobs, toPreToolDecision } from '../lib/gate.mjs'
import { classifyCommand, commandAsserts, splitSegments, stripAnsi, tokenize } from '../lib/shell.mjs'
import { detectClaims, evidenceFor } from '../lib/claims.mjs'
import { normalisePath } from '../lib/paths.mjs'
import { createTools } from '../tools.mjs'
import { createSkill } from '../lib/skill.mjs'
import { CLAIM_KIND_EVIDENCE, CLAIM_PATTERNS, EVIDENCE_KINDS, REASON_CODES } from '../lib/constants.mjs'

const config = resolveConfig({})
const CWD = process.cwd()

/**
 * One or more commands that MUST be recognised as each evidence kind.
 *
 * Why this table exists: the unit suite used to feed only four of the 27
 * patterns in EVIDENCE_KINDS. Replacing the table with a minimal one that kept
 * just those four still produced 61/61 green — 23 patterns were decoration.
 * The coverage test below checks every pattern object, not just every kind, so
 * deleting a single alternative turns the suite red.
 */
const EVIDENCE_PROBES = Object.freeze({
  'test-run': [
    'pytest -q',
    'python -m pytest -q',
    'python3 -m unittest',
    'npm test', 'npm run test',
    'pnpm test', 'pnpm run test',
    'yarn test',
    'go test ./...',
    'cargo test',
    'make test',
    'dotnet test',
    'mvn test',
    'gradle test', 'gradlew test',
    'node --test test/*.mjs',
    'bun test',
  ],
  'build-run': [
    'npm run build', 'pnpm build', 'yarn build',
    'cargo build',
    'go build ./...',
    'dotnet build',
    'mvn package', 'mvn install',
    'gradle build', 'gradlew build',
    'python -m build',
  ],
  'ci-check': [
    'gh run view 1', 'gh run list', 'gh run watch 1',
    'gh pr checks 3', 'gh workflow view ci',
    'gh api repos/x/y',
  ],
  'file-read': [
    'cat x', 'bat x', 'less x', 'more x', 'head x', 'tail x',
    'rg foo', 'grep foo', 'Select-String foo',
    'Get-Content a.md', 'Get-ChildItem', 'Test-Path x', 'Select-Object',
    'sed -n 1p x', 'awk "{print}" x',
    'git diff', 'git show abc', 'git log',
  ],
})

function shell(command, toolName = 'pwsh') {
  return { toolName, exec: { name: toolName, args: { command } } }
}

function writeCall(filePath, content, toolName = 'write') {
  return { toolName, exec: { name: toolName, args: { file_path: filePath, content } } }
}

function runGate(gate, payload) {
  const calls = []
  const decision = gate(payload, (...args) => {
    calls.push(args)
    return { kind: 'next' }
  })
  return { decision, nextCalls: calls.length }
}

function recordTestRun(ledger, ok = true) {
  return ledger.record({
    toolName: 'pwsh',
    exec: { name: 'pwsh', args: { command: 'python -m pytest -q' } },
    ok,
  })
}

function recordUnrelated(ledger) {
  return ledger.record({
    toolName: 'pwsh',
    exec: { name: 'pwsh', args: { command: 'Get-Content README.md' } },
    ok: true,
  })
}

// ---------------------------------------------------------------------------
// shell analysis
// ---------------------------------------------------------------------------

test('ansi escapes are stripped before anything else looks at the text', () => {
  const coloured = '\u001b[1;33m--version\u001b[0m'
  assert.equal(stripAnsi(coloured), '--version')
  // The point: with the escape left in, the flag below is invisible and the
  // command is treated as asserting.
  assert.equal(commandAsserts(coloured), false)
})

test('a git commit is an asserting action', () => {
  const result = classifyCommand('git commit -m "fix: tidy up"')
  assert.equal(result.length, 1)
  assert.equal(result[0].assertion, true)
  assert.equal(result[0].kind, 'git_commit')
  assert.deepEqual(result[0].messages, ['fix: tidy up'])
})

test('read-only git verbs never assert', () => {
  for (const command of ['git status', 'git log --oneline', 'git diff HEAD~1', 'git show abc123', 'git branch -a']) {
    assert.equal(commandAsserts(command), false, command)
  }
})

test('non-asserting flags suppress the gate', () => {
  for (const command of ['git push --dry-run', 'git commit --help', 'git push -h', 'git commit --version']) {
    assert.equal(commandAsserts(command), false, command)
  }
})

test('a quoted semicolon does not split the commit message', () => {
  const segments = splitSegments('git commit -m "fix: a; b && c"')
  assert.equal(segments.length, 1, JSON.stringify(segments))
  const [entry] = classifyCommand('git commit -m "fix: a; b && c"')
  assert.deepEqual(entry.messages, ['fix: a; b && c'])
})

test('an unquoted operator does split', () => {
  const segments = splitSegments('git fetch && git commit -m "x"')
  assert.equal(segments.length, 2, JSON.stringify(segments))
  const classified = classifyCommand('git fetch && git commit -m "x"')
  assert.equal(classified[0].assertion, false)
  assert.equal(classified[1].assertion, true)
})

test('a prefix does not hide the commit', () => {
  assert.equal(commandAsserts('cd repo && git commit -m "x"'), true)
  assert.equal(commandAsserts('FOO=1 git commit -m "x"'), true)
  assert.equal(commandAsserts('env FOO=1 sudo git commit -m "x"'), true)
})

test('-C is read as a working directory, not as an argument', () => {
  const [entry] = classifyCommand('git -C /tmp/repo commit -m "x"')
  assert.equal(entry.assertion, true)
  assert.equal(entry.cwd, '/tmp/repo')
})

test('message flags are read in each of their spellings', () => {
  assert.deepEqual(classifyCommand('git commit -m one -m two')[0].messages, ['one', 'two'])
  assert.deepEqual(classifyCommand('git commit --message=three')[0].messages, ['three'])
  assert.deepEqual(classifyCommand('git commit -mfour')[0].messages, ['four'])
})

test('a push and a tag assert even with no inline message', () => {
  assert.equal(classifyCommand('git push origin main')[0].kind, 'git_push')
  assert.equal(classifyCommand('git tag -a v1 -m "release"')[0].kind, 'git_tag')
})

test('tokenize respects both quote styles and escapes', () => {
  assert.deepEqual(tokenize("git commit -m 'a b'"), ['git', 'commit', '-m', 'a b'])
  assert.deepEqual(tokenize('git commit -m "a \\" b"'), ['git', 'commit', '-m', 'a " b'])
})

test('the trigger fires on a git commit inside a pwsh call', () => {
  // This is the defect that made the first version a no-op: triggers were
  // matched against the tool NAME, and the shell tool is called `pwsh`.
  const result = decideCall(config, createLedger({}), 'pwsh', shell('git commit -m "fix: x"'), CWD)
  assert.equal(result.gate_reason_code, REASON_CODES.NO_CLAIM)
  // Assert the trigger actually fired. The previous second assertion was
  // `notEqual(NO_CLAIM, NOT_TRIGGERED)`, which the line above already implies:
  // it stayed true even if the trigger never matched anything.
  assert.equal(result.detail.segments.length, 1)
  assert.equal(result.detail.segments[0].kind, 'git_commit')
  assert.equal(result.detail.segments[0].assertion, true)

  // Negative control, so the positive assertion above can go red: `read` is not
  // one of the watched tools, so the same call must take NOT_TRIGGERED.
  const control = decideCall(config, createLedger({}), 'read',
    { toolName: 'read', exec: { name: 'read', args: { file_path: 'a.txt' } } }, CWD)
  assert.equal(control.gate_reason_code, REASON_CODES.NOT_TRIGGERED)
})

// ---------------------------------------------------------------------------
// claim detection
// ---------------------------------------------------------------------------

test('the design patterns are detected', () => {
  const cases = [
    ['fix: tests pass', 'CLAIM_TEST_PASSED'],
    ['全部通过', 'CLAIM_TEST_PASSED'],
    ['测试通过', 'CLAIM_TEST_PASSED'],
    ['检查通过', 'CLAIM_TEST_PASSED'],
    ['docs: verified the install steps', 'CLAIM_VERIFIED'],
    ['已验证', 'CLAIM_VERIFIED'],
    ['已核实', 'CLAIM_VERIFIED'],
    ['已复现', 'CLAIM_VERIFIED'],
    ['已确认', 'CLAIM_VERIFIED'],
    ['已核对', 'CLAIM_VERIFIED'],
    ['ran the test suite', 'CLAIM_RAN_CHECK'],
    ['跑了', 'CLAIM_RAN_CHECK'],
    ['跑过', 'CLAIM_RAN_CHECK'],
    ['已运行', 'CLAIM_RAN_CHECK'],
    ['the build succeeds now', 'CLAIM_BUILD_OK'],
    ['构建成功', 'CLAIM_BUILD_OK'],
    ['构建通过', 'CLAIM_BUILD_OK'],
    ['supports --strict mode', 'CLAIM_CLI_ASSERTION'],
    ['adds npm run build to CI', 'CLAIM_CLI_ASSERTION'],
    ['phocinae-publish-gate check', 'CLAIM_CLI_ASSERTION'],
    ['windows-only for now', 'CLAIM_DEPENDENCY'],
    ['依赖 Windows', 'CLAIM_DEPENDENCY'],
    ['只在 Windows', 'CLAIM_DEPENDENCY'],
    ['只支持 Linux', 'CLAIM_DEPENDENCY'],
    ['see L42 for the fix', 'CLAIM_LINE_REF'],
    ['see line 42 for the fix', 'CLAIM_LINE_REF'],
    ['见第 42 行', 'CLAIM_LINE_REF'],
    ['第42行', 'CLAIM_LINE_REF'],
    ['cuts 53 / 53 cases', 'CLAIM_COUNT'],
    ['removes 12 tests', 'CLAIM_COUNT'],
    ['修复了 3 个 bug', 'CLAIM_COUNT'],
    ['新增 5 条规则', 'CLAIM_COUNT'],
    ['完成 8 项检查', 'CLAIM_COUNT'],
    ['reverts 612e5bd', 'CLAIM_HASH_REF'],
    ['adds `lib/gate.mjs`', 'CLAIM_FILE_EXISTS'],
    ['文件 lib/gate.mjs 已改', 'CLAIM_FILE_EXISTS'],
    ['file lib/gate.mjs changed', 'CLAIM_FILE_EXISTS'],
  ]
  for (const [text, id] of cases) {
    const ids = detectClaims(text).map((claim) => claim.id)
    assert.ok(ids.includes(id), `${JSON.stringify(text)} should match ${id}, got ${ids.join(',')}`)
  }
})

test('an ordinary commit message asserts nothing', () => {
  assert.deepEqual(detectClaims('fix(config): handle an empty list'), [])
  assert.deepEqual(detectClaims(''), [])
  assert.deepEqual(detectClaims('   '), [])
})

test('a claim split by an ansi escape is still found', () => {
  assert.equal(detectClaims('tests \u001b[32mpass\u001b[0m').length > 0, true)
})

test('every pattern id is unique and every kind is mapped', () => {
  const ids = CLAIM_PATTERNS.map((pattern) => pattern.id)
  assert.equal(new Set(ids).size, ids.length, 'pattern ids must be unique')
  for (const pattern of CLAIM_PATTERNS) {
    assert.ok(pattern.kind in CLAIM_KIND_EVIDENCE, `${pattern.id} has unmapped kind ${pattern.kind}`)
  }
})

test('every evidence kind referenced by a claim mapping exists', () => {
  const known = new Set(Object.keys(EVIDENCE_KINDS))
  for (const [kind, evidence] of Object.entries(CLAIM_KIND_EVIDENCE)) {
    for (const entry of evidence) {
      assert.ok(known.has(entry), `claim kind ${kind} references unknown evidence ${entry}`)
    }
  }
})

test('every EVIDENCE_KINDS pattern has a positive probe', () => {
  const uncovered = []
  for (const [kind, spec] of Object.entries(EVIDENCE_KINDS)) {
    const probes = EVIDENCE_PROBES[kind] ?? []
    for (const pattern of spec.patterns) {
      if (!probes.some((command) => pattern.test(command))) {
        uncovered.push(`${kind}: ${pattern}`)
      }
    }
  }
  assert.deepEqual(uncovered, [], `patterns with no positive probe:\n${uncovered.join('\n')}`)
})

test('every positive evidence probe is recorded as that kind', () => {
  for (const [kind, probes] of Object.entries(EVIDENCE_PROBES)) {
    for (const command of probes) {
      const kinds = evidenceFrom('pwsh', command, true)
      assert.ok(kinds.has(kind),
        `${JSON.stringify(command)} should provide ${kind}, got [${[...kinds].join(', ')}]`)
    }
  }
})

test('mustSucceed evidence kinds are refused when the run failed', () => {
  for (const kind of ['test-run', 'build-run']) {
    for (const command of EVIDENCE_PROBES[kind]) {
      assert.equal(evidenceFrom('pwsh', command, false).has(kind), false, command)
    }
  }
})

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

test('a successful test run is recorded as evidence', () => {
  const ledger = createLedger({})
  assert.deepEqual(recordTestRun(ledger, true).kinds, ['test-run'])
})

test('a FAILED test run is not evidence that tests pass', () => {
  const ledger = createLedger({})
  assert.equal(recordTestRun(ledger, false), null)
  assert.equal(ledger.has('test-run'), false)
})

test('an unknown outcome is not a failure and satisfies nothing', () => {
  const ledger = createLedger({})
  ledger.record({ toolName: 'pwsh', exec: { name: 'pwsh', args: { command: 'pytest' } } })
  assert.equal(ledger.has('test-run'), false)
})

test('a CI observation counts even when CI is red', () => {
  const ledger = createLedger({})
  ledger.record({ toolName: 'pwsh', exec: { name: 'pwsh', args: { command: 'gh run watch 1' } }, ok: false })
  assert.equal(ledger.has('ci-check'), true)
})

test('a read counts whatever the exit code', () => {
  const ledger = createLedger({})
  ledger.record({ toolName: 'pwsh', exec: { name: 'pwsh', args: { command: 'Get-Content a.md' } }, ok: false })
  assert.equal(ledger.has('file-read'), true)
})

test('a read-shaped tool with no command is evidence of a read', () => {
  const ledger = createLedger({})
  ledger.record({ toolName: 'read', exec: { name: 'read', args: { file_path: 'a.txt' } } })
  assert.equal(ledger.has('file-read'), true)
})

test('a shell tool with an unreadable command provides no evidence', () => {
  const ledger = createLedger({})
  assert.equal(ledger.record({ toolName: 'pwsh', exec: { name: 'pwsh', args: {} } }), null)
})

test('evidenceFrom honours mustSucceed per kind', () => {
  assert.equal(evidenceFrom('pwsh', 'pytest', false).has('test-run'), false)
  assert.equal(evidenceFrom('pwsh', 'pytest', true).has('test-run'), true)
  assert.equal(evidenceFrom('pwsh', 'gh run view 1', false).has('ci-check'), true)
  assert.equal(evidenceFrom('pwsh', 'cat x', false).has('file-read'), true)
  assert.equal(evidenceFrom('pwsh', 'npm run build', true).has('build-run'), true)
  assert.equal(evidenceFrom('pwsh', 'npm run build', false).has('build-run'), false)
})

test('the ledger is bounded and reports what aged out', () => {
  const ledger = createLedger({ limit: 3 })
  for (let i = 0; i < 5; i += 1) recordTestRun(ledger, true)
  const stats = ledger.stats()
  assert.equal(stats.size, 3)
  assert.equal(stats.dropped, 2)
  assert.equal(stats.everRecorded, true)
})

test('a malformed payload does not throw out of the ledger', () => {
  const ledger = createLedger({})
  for (const payload of [null, undefined, 'text', 42, { exec: { args: { command: 7 } } }]) {
    assert.equal(ledger.record(payload), null)
  }
})

test('command and success extraction are defensive', () => {
  assert.equal(extractCommand({ exec: { args: { command: 'x' } } }), 'x')
  assert.equal(extractCommand({}), '')
  assert.equal(extractSuccess({ ok: true }), true)
  assert.equal(extractSuccess({ ok: false }), false)
  assert.equal(extractSuccess({ result: { exitCode: 0 } }), true)
  assert.equal(extractSuccess({ result: { isError: true } }), false)
  assert.equal(extractSuccess({ error: 'boom' }), false)
  assert.equal(extractSuccess({}), null, 'unknown is not false')
})

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

test('an unwatched tool is allowed', () => {
  const result = decideCall(config, createLedger({}), 'read_image', { exec: { name: 'read_image' } }, CWD)
  assert.equal(result.gate_decision, 'allow')
  assert.equal(result.gate_reason_code, REASON_CODES.NOT_TRIGGERED)
})

test('a commit with no claim is allowed', () => {
  const result = decideCall(config, createLedger({}), 'pwsh', shell('git commit -m "fix: tidy up"'), CWD)
  assert.equal(result.gate_decision, 'allow')
  assert.equal(result.gate_reason_code, REASON_CODES.NO_CLAIM)
})

test('a claim backed by a recorded test run is allowed', () => {
  const ledger = createLedger({})
  recordTestRun(ledger, true)
  const result = decideCall(config, ledger, 'pwsh', shell('git commit -m "fix: tests pass"'), CWD)
  assert.equal(result.gate_decision, 'allow')
  assert.equal(result.gate_reason_code, REASON_CODES.EVIDENCE_PRESENT)
  assert.equal(result.model_calls, 0)
})

test('a claim with no evidence is stopped', () => {
  const ledger = createLedger({})
  recordUnrelated(ledger)
  const result = decideCall(config, ledger, 'pwsh', shell('git commit -m "fix: tests pass"'), CWD)
  assert.equal(result.gate_decision, 'review')
  assert.equal(result.gate_reason_code, REASON_CODES.CLAIM_UNBACKED)
  assert.equal(result.model_verdict, 'claim_unbacked')
  assert.ok(result.missing_evidence.includes('test-run'))
})

test('A CLAIM CANNOT SATISFY ITS OWN OBLIGATION', () => {
  const ledger = createLedger({})
  const result = decideCall(config, ledger, 'pwsh',
    shell('git commit -m "tests pass; ran pytest; all tests pass"'), CWD)
  assert.notEqual(result.gate_decision, 'allow')
  assert.equal(ledger.has('test-run'), false, 'reviewing an action must not record evidence')
})

test('an empty ledger asks, and says it cannot tell', () => {
  const ledger = createLedger({})
  const result = decideCall(config, ledger, 'pwsh', shell('git commit -m "tests pass"'), CWD)
  assert.equal(result.gate_decision, 'review')
  assert.equal(result.gate_reason_code, REASON_CODES.LEDGER_EMPTY)
  assert.equal(result.uncertain, true)
  assert.match(result.gate_message, /cannot tell/)
})

test('decision governs, and deny is available', () => {
  const strict = resolveConfig({ decision: 'deny' })
  const ledger = createLedger({})
  recordUnrelated(ledger)
  const result = decideCall(strict, ledger, 'pwsh', shell('git commit -m "tests pass"'), CWD)
  assert.equal(result.gate_decision, 'deny')
})

test('a claim no evidence could answer is tool_unverified, not a lie', () => {
  const ledger = createLedger({})
  recordTestRun(ledger, true)
  // A hash reference: nothing this gate observes confirms or contradicts it.
  const result = decideCall(config, ledger, 'pwsh', shell('git commit -m "reverts abc1234"'), CWD)
  const kinds = result.claims.map((claim) => claim.kind)
  if (kinds.every((kind) => (CLAIM_KIND_EVIDENCE[kind] ?? []).length === 0)) {
    assert.equal(result.model_verdict, 'tool_unverified')
    assert.match(result.gate_message, /human/)
  }
})

test('the result carries the design fields', () => {
  const result = decideCall(config, createLedger({}), 'pwsh', shell('git commit -m "tests pass"'), CWD)
  for (const key of ['gate_decision', 'gate_reason_code', 'model_verdict', 'model_calls',
    'evidence_summary', 'missing_evidence', 'claims']) {
    assert.ok(key in result, `result must carry ${key}`)
  }
  assert.equal(result.model_calls, 0)
})

// ---------------------------------------------------------------------------
// write-shaped actions
// ---------------------------------------------------------------------------

test('a README write carrying a claim is gated', () => {
  const ledger = createLedger({})
  recordUnrelated(ledger)
  const result = decideCall(config, ledger, 'write',
    writeCall('README.md', '# Project\n\nAll tests pass.\n'), CWD)
  assert.equal(result.gate_decision, 'review')
  assert.equal(result.gate_reason_code, REASON_CODES.CLAIM_UNBACKED)
})

test('a source-file write is not gated even with a claim in it', () => {
  const result = decideCall(config, createLedger({}), 'write',
    writeCall('src/index.mjs', '// all tests pass\n'), CWD)
  assert.equal(result.gate_decision, 'allow')
  assert.equal(result.gate_reason_code, REASON_CODES.NO_CLAIM)
})

test('a docs markdown write is gated', () => {
  const ledger = createLedger({})
  recordTestRun(ledger, true)
  const result = decideCall(config, ledger, 'write',
    writeCall('docs/guide.md', 'Verified on Windows.'), CWD)
  // `CLAIM_VERIFIED` is answered by no evidence this gate can observe, so a
  // populated ledger containing a test run does not make it pass; the verdict is
  // the honest "a human has to decide this one".
  assert.equal(result.gate_decision, 'review')
  assert.equal(result.gate_reason_code, REASON_CODES.TOOL_UNVERIFIED)
  assert.equal(result.model_verdict, 'tool_unverified')
})

test('A GENERIC FILE READ DOES NOT VERIFY A CLAIM', () => {
  // The defect this pins: `CLAIM_VERIFIED` was once answered by `file-read`, so
  // "verified on Windows" passed as soon as anything at all had been read. That
  // made the gate agree with a claim it had no basis to agree with — the one
  // direction a gate must never fail in.
  const ledger = createLedger({})
  assert.ok(recordUnrelated(ledger), 'the ledger holds a file read')
  assert.equal(ledger.has('file-read'), true)

  const result = decideCall(config, ledger, 'write',
    writeCall('README.md', 'Verified on Windows.'), CWD)
  assert.notEqual(result.gate_decision, 'allow')
  assert.equal(result.gate_reason_code, REASON_CODES.TOOL_UNVERIFIED)
})

test('citing a file IS answered by having read it', () => {
  // The distinction the fix preserves: `file-read` still answers claims about
  // files and lines, where reading the file is the actual connection.
  const ledger = createLedger({})
  recordUnrelated(ledger)
  const result = decideCall(config, ledger, 'pwsh',
    shell('git commit -m "adds `lib/gate.mjs`"'), CWD)
  const fileClaim = result.claims.find((claim) => claim.kind === 'file')
  if (fileClaim) {
    assert.equal(fileClaim.answerable, true)
    assert.equal(fileClaim.satisfied, true)
    assert.deepEqual(result.missing_evidence, [])
  }
})

test('a path outside the working directory is not judged', () => {
  const result = decideCall(config, createLedger({}), 'write',
    writeCall('../outside/README.md', 'all tests pass'), CWD)
  assert.equal(result.gate_decision, 'allow')
  assert.equal(result.gate_reason_code, REASON_CODES.NO_CLAIM)
  assert.equal(result.detail.outsideCwd, true)
})

test('normalisePath collapses traversal and reports containment', () => {
  const inside = normalisePath('docs/../README.md', CWD)
  assert.equal(inside.relative, 'README.md')
  assert.equal(inside.insideCwd, true)
  assert.equal(normalisePath('../../etc/passwd', CWD).insideCwd, false)
})

test('glob matching happens after normalisation, so traversal cannot hide a path', () => {
  // `docs/../README.md` must be judged as `README.md`. Matching the raw string
  // would miss it, and a write to a README under a traversal spelling would then
  // escape the gate entirely.
  const result = decideCall(config, createLedger({}), 'write',
    writeCall('docs/../README.md', 'All tests pass.'), CWD)
  assert.equal(result.gate_reason_code, REASON_CODES.LEDGER_EMPTY)
  assert.equal(result.detail.path, 'README.md')
})

test('glob forms behave as documented', () => {
  const globs = ['README*', 'CHANGELOG*', 'docs/**/*.md', '**/README.md']
  // `**` crosses directories and `*` does not.
  assert.equal(matchesGlobs('docs/guide.md', globs), true)
  assert.equal(matchesGlobs('docs/a/b/c.md', globs), true)
  assert.equal(matchesGlobs('src/README.md', globs), true)
  assert.equal(matchesGlobs('CHANGELOG.md', globs), true)
  assert.equal(matchesGlobs('docs/guide.txt', globs), false)
  assert.equal(matchesGlobs('src/index.mjs', globs), false)
  // Case-insensitive, because a gate that fires on Linux and not on Windows is
  // worse than one that fires on neither.
  assert.equal(matchesGlobs('readme.md', globs), true)
  assert.equal(matchesGlobs('DOCS/Guide.MD', globs), true)
})

// ---------------------------------------------------------------------------
// listener discipline
// ---------------------------------------------------------------------------

test('next() is called exactly once on the allow path', () => {
  const gate = createPreExecuteGate(config, createLedger({}), null, CWD)
  const { decision, nextCalls } = runGate(gate, shell('git commit -m "fix: tidy"'))
  assert.equal(nextCalls, 1)
  assert.equal(decision.kind, 'next')
})

test('next() is NOT called on the review path', () => {
  const gate = createPreExecuteGate(config, createLedger({}), null, CWD)
  const { decision, nextCalls } = runGate(gate, shell('git commit -m "tests pass"'))
  assert.equal(nextCalls, 0, 'delegating on a non-allow path would let the call through')
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /dsh-preclaim/)
})

test('a deny never delegates', () => {
  const strict = resolveConfig({ decision: 'deny' })
  const ledger = createLedger({})
  recordUnrelated(ledger)
  const gate = createPreExecuteGate(strict, ledger, null, CWD)
  const { decision, nextCalls } = runGate(gate, shell('git commit -m "tests pass"'))
  assert.equal(nextCalls, 0)
  assert.equal(decision.kind, 'deny')
})

test('a payload with no tool name asks rather than allowing', () => {
  const gate = createPreExecuteGate(config, createLedger({}), null, CWD)
  const { decision, nextCalls } = runGate(gate, { exec: { args: { command: 'git commit -m x' } } })
  assert.equal(nextCalls, 0)
  assert.equal(decision.kind, 'ask')
})

test('A THROW INSIDE THE GATE BECOMES ASK, NEVER ALLOW', () => {
  const broken = {
    ...config,
    get triggerTools() {
      throw new Error('boom')
    },
  }
  const gate = createPreExecuteGate(broken, createLedger({}), null, CWD)
  const { decision, nextCalls } = runGate(gate, shell('git commit -m x'))
  assert.equal(nextCalls, 0, 'a gate defect must not become a silent allow')
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /the gate failed/)
})

test('toPreToolDecision never returns allow for a non-allow result', () => {
  assert.deepEqual(toPreToolDecision({ gate_decision: 'allow' }), { kind: 'allow' })
  assert.equal(toPreToolDecision({ gate_decision: 'review', gate_message: 'm' }).kind, 'ask')
  assert.equal(toPreToolDecision({ gate_decision: 'deny', gate_message: 'm' }).kind, 'deny')
  // Unreadable results must not read as allow.
  assert.equal(toPreToolDecision(null).kind, 'ask')
  assert.equal(toPreToolDecision(undefined).kind, 'ask')
  assert.equal(toPreToolDecision({}).kind, 'ask')
  assert.equal(toPreToolDecision({ gate_decision: 'nonsense' }).kind, 'ask')
  assert.match(toPreToolDecision({}).reason, /could not interpret/)
})

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

test('an empty triggerTools list is refused, not treated as a no-op', () => {
  assert.throws(() => resolveConfig({ triggerTools: [] }), (error) => {
    assert.equal(error.code, ERROR_CODES.BAD_CONFIG)
    assert.ok(error instanceof PreclaimError)
    return true
  })
})

test('an empty readmeGlobs list is refused', () => {
  assert.throws(() => resolveConfig({ readmeGlobs: [] }), PreclaimError)
})

test('there is no config value that lets an unbacked claim through', () => {
  for (const value of ['allow', 'skip', 'off', true]) {
    assert.throws(() => resolveConfig({ decision: value }), PreclaimError, String(value))
  }
})

test('bad numeric and boolean options are refused', () => {
  for (const options of [
    { ledgerLimit: 0 }, { ledgerLimit: -1 }, { ledgerLimit: 1.5 },
    { pushMessageLimit: 0 }, { audit: 'yes' }, { triggerTools: 'pwsh' },
  ]) {
    assert.throws(() => resolveConfig(options), PreclaimError, JSON.stringify(options))
  }
})

test('toolMatches handles globs, case and exact names', () => {
  assert.equal(toolMatches('pwsh', 'pwsh'), true)
  assert.equal(toolMatches('pwsh', 'PWSh'), true)
  assert.equal(toolMatches('pwsh', 'bash'), false)
  assert.equal(toolMatches('*', 'anything'), true)
  assert.equal(toolMatches('str_*', 'str_replace_editor'), true)
  assert.equal(toolMatches('pwsh', ''), false)
})

// ---------------------------------------------------------------------------
// tools and skill
// ---------------------------------------------------------------------------

test('the tool definition stays inside the host JSON Schema subset', () => {
  const tools = createTools(config, createLedger({}))
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'evidence_status')
  assert.ok(tool.parameters, 'the model-facing field is `parameters`')
  assert.equal(tool.inputSchema, undefined)
  assert.ok(tool.output && tool.output.schema)

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    if (!node || typeof node !== 'object') return
    if ('type' in node) assert.equal(typeof node.type, 'string', `${path}.type must be one scalar type`)
    if ('required' in node) {
      assert.ok(Array.isArray(node.required), `${path}.required must be an array`)
    }
    assert.notEqual(node.required, true, `${path} must not use per-property required: true`)
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
  walk(tool.parameters, 'parameters')
  walk(tool.output.schema, 'output.schema')
})

test('evidence_status reports the ledger and checks a candidate text', async () => {
  const ledger = createLedger({})
  const tool = createTools(config, ledger)[0]

  let result = await tool.execute({})
  assert.equal(result.ledger.everRecorded, false)

  result = await tool.execute({ text: 'fix: tests pass' })
  assert.deepEqual(result.claims.map((claim) => claim.id), ['CLAIM_TEST_PASSED'])
  assert.equal(result.wouldDecide, 'review')
  assert.ok(result.wouldReason.length > 0)

  recordTestRun(ledger, true)
  result = await tool.execute({ text: 'fix: tests pass' })
  assert.equal(result.wouldDecide, 'allow')
  assert.ok(result.evidence.includes('test-run'))
})

test('the tool output carries exactly the declared keys', async () => {
  const tool = createTools(config, createLedger({}))[0]
  const declared = new Set(Object.keys(tool.output.schema.properties))
  const result = await tool.execute({ text: 'tests pass' })
  for (const key of Object.keys(result)) {
    assert.ok(declared.has(key), `undeclared output key ${key}`)
  }
  for (const key of declared) {
    assert.ok(key in result, `declared key ${key} missing`)
  }
})

test('the skill is generated from the live config', () => {
  const skill = createSkill(config, createLedger({}))
  assert.equal(skill.name, 'preclaim')
  for (const tool of config.triggerTools) {
    assert.match(skill.body, new RegExp(tool), `skill must mention ${tool}`)
  }
  assert.match(skill.body, /evidence_status/)
})
