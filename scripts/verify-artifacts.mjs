#!/usr/bin/env node
/**
 * Inspect the packed artefact before publishing.
 *
 * Validating the repository is not the same as validating what `npm publish`
 * would ship: `files` decides what travels, and a missing entry there is
 * invisible until somebody installs the package and finds a dangling reference.
 * That failure mode has a specific shape here — the bundled patch names
 * `dsh-evidence-gate`, so if `package.json`'s `name` ever drifts from the patch
 * the plugin installs and then fails to resolve.
 *
 * Run with `--pack` to also build the real tarball with `npm pack --dry-run` and
 * check its contents list.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checked = []

function check(label, condition, detail = '') {
  checked.push(label)
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label)
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

const pkg = readJson('package.json')

// --- the thing that actually breaks installs --------------------------------
const patchPath = pkg.dsh?.bundle?.patch
check('package.json declares dsh.bundle.patch', typeof patchPath === 'string', String(patchPath))
check('manifestVersion is 1', pkg.dsh?.manifestVersion === 1, String(pkg.dsh?.manifestVersion))
check('the patch file exists', existsSync(join(ROOT, patchPath ?? '')), String(patchPath))

const patch = readFileSync(join(ROOT, patchPath), 'utf8')
check(
  'THE PATCH NAMES THE PACKAGE',
  patch.includes(`name: ${pkg.name}`),
  `patch must mount a module named exactly ${pkg.name}; npm publishes under that name, `
    + 'so a mismatch produces a plugin that installs and then fails to resolve',
)
check('the patch enables the bundle', /insert:/.test(patch))

// --- node engines -----------------------------------------------------------
check('engines.node is declared', typeof pkg.engines?.node === 'string')
check('engines.node excludes the EOL lines', !/[<^]?\s*18\./.test(pkg.engines?.node ?? ''))

// --- files that `files` must not drop ---------------------------------------
const REQUIRED = [
  'index.mjs',
  'tools.mjs',
  'lib/constants.mjs',
  'lib/config.mjs',
  'lib/errors.mjs',
  'lib/ledger.mjs',
  'lib/gate.mjs',
  'lib/claims.mjs',
  'lib/shell.mjs',
  'lib/paths.mjs',
  'lib/skill.mjs',
  'skills/preclaim/SKILL.md',
  'cordis.patch.yml',
  'README.md',
  'README-zh.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
]
for (const rel of REQUIRED) {
  check(`file exists: ${rel}`, existsSync(join(ROOT, rel)))
}

const files = pkg.files ?? []
for (const rel of REQUIRED) {
  // `files` entries are prefixes/dirs; a directory entry covers its children.
  const covered = files.some((entry) => rel === entry || rel.startsWith(`${entry}/`))
  check(`files[] covers ${rel}`, covered, `"${rel}" would not travel with the package`)
}

// --- no test code or secrets in the shipped set ------------------------------
const shipped = [...files].join('\n')
check('files[] does not include tests', !/(^|\n)test(\/|$)/m.test(shipped), shipped)
check('files[] does not include scripts', !/(^|\n)scripts(\/|$)/m.test(shipped))
check('files[] declares an explicit allow-list', files.length > 0 && !files.includes('*'))

// --- package identity -------------------------------------------------------
// The npm name registry has several same-topic neighbours held by other authors
// (`dsh-evidence-gate`, `dsh-evidence`, `dsh-claim-gate`, `dsh-attest`). The
// project's design picked `dsh-preclaim` because it was the free one that names
// the right moment; this check keeps a later edit from drifting back onto a name
// somebody else owns.
const TAKEN_BY_OTHERS = ['dsh-evidence', 'dsh-evidence-gate', 'dsh-claim-gate', 'dsh-attest']
check(
  'the name was not taken by another author',
  !TAKEN_BY_OTHERS.includes(pkg.name),
  `${pkg.name} is held by another author; the published name is dsh-preclaim`,
)
check('the design-chosen name is in place', pkg.name === 'dsh-preclaim', pkg.name)
check('license is declared', typeof pkg.license === 'string' && pkg.license !== '')
check('no runtime dependencies', Object.keys(pkg.dependencies ?? {}).length === 0,
  JSON.stringify(pkg.dependencies))
check('the repository URL points at the design-chosen repo',
  (pkg.repository?.url ?? '').includes('Phocinae/dsh-evidence'),
  String(pkg.repository?.url))

// --- the entry actually loads ----------------------------------------------
try {
  // `pathToFileURL`, not the bare path: on Windows an absolute path is `D:\...`,
  // which the ESM loader rejects with "Only URLs with a scheme in: file, data,
  // and node are supported". A verifier that cannot import the entry reports
  // "does not load" for every platform-specific reason except a real one.
  const mod = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  check('index.mjs exports createPlugin', typeof mod.createPlugin === 'function')
  check('index.mjs exports a default', typeof mod.default === 'function')
  check('BUNDLE_NAME matches package.json',
    mod.BUNDLE_NAME === pkg.name,
    `${mod.BUNDLE_NAME} vs ${pkg.name}`)
  // A plugin body that throws without a context is correct; that it *reaches*
  // that check proves the module graph resolved.
  let threw = null
  try {
    mod.createPlugin(null, {})
  } catch (error) {
    threw = error
  }
  check('createPlugin refuses a ctx with no .on()', threw !== null)
} catch (error) {
  check('index.mjs imports cleanly', false, String(error && error.message))
}

// --- report -----------------------------------------------------------------
console.log(`inspecting ${pkg.name}@${pkg.version} at ${ROOT}`)
console.log(`checked ${checked.length} conditions`)
if (failures.length === 0) {
  console.log('OK: the packed artefact would carry every file the patch needs, '
    + 'the patch names the package, and the entry loads')
  process.exit(0)
}
console.log('')
for (const failure of failures) console.log(`FAIL ${failure}`)
process.exit(1)
