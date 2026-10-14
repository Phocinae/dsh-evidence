/**
 * Path handling for write-shaped actions.
 *
 * Two jobs, both about not judging things this gate has no business judging:
 *
 *  1. **Normalise** so `docs/../README.md` and `README.md` are one path.
 *  2. **Refuse to leave the working directory.** A write to a path outside `cwd`
 *     is not this gate's business, and reporting a claim in a file the session
 *     has no business touching would be worse than staying quiet.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Normalise a path against a working directory.
 *
 * Returns `{ absolute, relative, insideCwd }`. `relative` always uses forward
 * slashes, so glob matching does not depend on the platform.
 */
export function normalisePath(raw, cwd = process.cwd()) {
  const text = String(raw ?? '').trim()
  if (text === '') return { absolute: '', relative: '', insideCwd: false }

  const base = resolve(cwd)
  const absolute = isAbsolute(text) ? resolve(text) : resolve(base, text)
  const rel = relative(base, absolute)
  const insideCwd = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))

  return {
    absolute,
    relative: rel.split(sep).join('/'),
    insideCwd,
  }
}
