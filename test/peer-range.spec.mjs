import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import semver from 'semver'

/**
 * Guard the peer range against the ways it has already been wrong.
 *
 * The first range written for this plugin was `>=0.1.2-alpha.2 <0.2.0`, derived
 * with `semver.satisfies(..., { includePrerelease: true })`. npm's resolver does
 * NOT use that option: a `>=` comparator whose own version carries a prerelease
 * only admits that same major.minor.patch tuple. So the range admitted the
 * 0.1.2-alpha.* line and nothing else, while reading as though it covered
 * everything from alpha.2 onward. An empty-project install is what caught it.
 *
 * The rules encoded here:
 *   1. a range must be checked the way npm checks it (no includePrerelease);
 *   2. one comparator per prerelease tuple, because `<` never excludes a
 *      prerelease of a later tuple;
 *   3. every line the package claims must be installable AT ALL upstream — a
 *      line where the dsh packages conflict with each other cannot be reached by
 *      any consumer, so claiming it would be a promise nobody can accept.
 */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const DSH_DEPS = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']

/** Lines this package claims to support, and that are installable upstream. */
const CLAIMED_LINES = ['0.1.2-rc.1', '0.1.3-alpha.2', '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2']

/** Lines excluded on purpose: no consumer can install them (upstream ERESOLVE). */
const EXCLUDED_LINES = ['0.1.2-alpha.2', '0.1.3-alpha.1', '0.1.5-alpha.1-0']

/** Published versions, cached per process. */
const published = new Map()
function versionsOf(dep) {
  if (!published.has(dep)) {
    const out = execFileSync('npm', ['view', dep, 'versions', '--json'], { encoding: 'utf8' })
    published.set(dep, JSON.parse(out))
  }
  return published.get(dep)
}

for (const dep of DSH_DEPS) {
  test(`peer range for ${dep} admits every claimed line and refuses the rest`, () => {
    const range = pkg.peerDependencies[dep]
    assert.ok(range, 'the dsh peer dependency must be declared')

    for (const line of CLAIMED_LINES) {
      assert.ok(
        semver.satisfies(line, range),
        `"${range}" must admit ${line} (checked the way npm checks it)`,
      )
    }
    // A comparator whose own version is a prerelease only spans its own tuple,
    // so a single `>=` can never cover several lines. Require one per tuple.
    const tuples = new Set(CLAIMED_LINES.map(v => `${semver.major(v)}.${semver.minor(v)}.${semver.patch(v)}`))
    const clauses = range.split('||').map(s => s.trim())
    assert.ok(
      clauses.length >= tuples.size,
      `"${range}" has ${clauses.length} clause(s) for ${tuples.size} lines; one comparator per prerelease tuple is required`,
    )
  })

  test(`peer range for ${dep} admits nothing it was not tested against`, () => {
    const range = pkg.peerDependencies[dep]
    const admitted = versionsOf(dep).filter(v => semver.satisfies(v, range))
    const unexpected = admitted.filter(v => !CLAIMED_LINES.includes(v))
    assert.deepEqual(
      unexpected, [],
      `"${range}" admits versions this package was never installed against: ${unexpected.join(', ')}`,
    )
  })

  test(`peer range for ${dep} excludes the alpha lines no consumer can install`, () => {
    const range = pkg.peerDependencies[dep]
    for (const line of EXCLUDED_LINES) {
      if (!versionsOf(dep).includes(line)) continue
      assert.ok(
        !semver.satisfies(line, range),
        `${line} cannot be installed upstream (the dsh packages conflict on it), so it must not be claimed`,
      )
    }
  })
}

test('the bare-comparator trap stays fixed', () => {
  // `>=0.1.2` with no prerelease matches NOTHING among dsh's all-prerelease
  // versions, and fails at install time as ETARGET with no hint why.
  for (const dep of DSH_DEPS) {
    const range = pkg.peerDependencies[dep]
    const bare = range.match(/(^|\|\|)\s*(>=|\^|~)?\s*(\d+\.\d+\.\d+)\s*(?=\|\||$)/)
    assert.equal(bare, null, `"${range}" contains a bare release comparator, which matches no dsh version`)
  }
})
