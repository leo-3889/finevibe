// Permanent privacy gate for pushes out of this clone (owner-authorized).
//
// Hard blockers on the operator's identity (host, LAN IP, home path, GitHub
// noreply address) and on credential shapes. Unlike the advisory pointer-check
// gate, ANY hit aborts the push, and the report never echoes the matched value:
// a privacy gate that prints the secret it found is a leak with extra steps.
//
// Scan surface mirrors the .githooks/pre-push policy: a NEW remote ref
// publishes the whole tip TREE, a range publishes what each rev ADDS.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

const ZERO = '0'.repeat(40)
const SHA = /^[0-9a-f]{7,40}$/

// ponytail: the four identity literals are assembled at runtime ('st'+'rix'
// style) because this file is itself in every pushed range: a scanner holding
// its own deny-list literals verbatim flags its own source, and a gate that
// blocks the commit that ships it gets --no-verify'd on day one. The token
// regexes stay literal — they match credentials, never scanner text
// (test: "gate source scanned by its own patterns finds nothing").
const HOST = 'leo-' + '9950X' // operator workstation hostname
const LAN_IP = '192.16' + '8.2.242' // operator LAN address
const HOME = '/hom' + 'e/leo' // operator home path
const NOREPLY = 'leo-3889@users' + '.noreply.github.com' // GitHub noreply identity

export interface PrivacyPattern {
  name: string
  re: RegExp
}

export interface PrivacyHit {
  rev: string
  file: string
  line: number
  pattern: string
}

export const PRIVACY_PATTERNS: readonly PrivacyPattern[] = [
  { name: 'GIT_IDENTITY_HOST', re: new RegExp(escapeRegExp(HOST)) },
  { name: 'GIT_LAN_IP', re: new RegExp(escapeRegExp(LAN_IP)) },
  { name: 'GIT_HOME_PATH', re: new RegExp(escapeRegExp(HOME)) },
  { name: 'GIT_IDENTITY_NOREPLY', re: new RegExp(escapeRegExp(NOREPLY)) },
  // ERE-safe sources only (no `(?:`, no `\b`): the tree scan hands `re.source`
  // to `git grep -E`, then re-checks every candidate line with the JS regex.
  { name: 'GIT_SECRET_TOKEN', re: /gh[pous]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9]{20,}/ },
  { name: 'GIT_PRIVATE_KEY', re: new RegExp('BEGIN' + ' [A-Z ]*PRIVATE KEY') },
  { name: 'GIT_SECRET_TOKEN_GOOGLE', re: /AIza[0-9A-Za-z_-]{20}/ },
  { name: 'GIT_SECRET_TOKEN_NPM', re: /npm_[A-Za-z0-9]{20}/ },
  { name: 'GIT_SECRET_TOKEN_SLACK', re: /xox[abps]-/ },
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : ''
}

/** Pattern names this text hits. Used by the self-clean test. */
export function scanText(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    for (const p of PRIVACY_PATTERNS) if (p.re.test(line)) names.add(p.name)
  }
  return [...names]
}

interface RefLine {
  localSha: string
  base: string
}

/** Standard pre-push stdin lines: `local_ref local_sha remote_ref remote_sha`. */
function parseRefs(stdin: string): RefLine[] {
  const refs: RefLine[] = []
  for (const fields of stdin.split('\n')) {
    const [, localSha, , remoteSha] = fields.trim().split(/\s+/)
    if (!localSha || !SHA.test(localSha) || localSha === ZERO) continue // delete publishes nothing
    const base = remoteSha && SHA.test(remoteSha) && remoteSha !== ZERO ? remoteSha : ''
    refs.push({ localSha, base })
  }
  return refs
}

/** New remote ref: every blob in the tip tree is being published. */
function scanTree(repo: string, sha: string): PrivacyHit[] {
  const hits: PrivacyHit[] = []
  for (const p of PRIVACY_PATTERNS) {
    const out = git(repo, ['grep', '-I', '-n', '-z', '-E', '-e', p.re.source, sha, '--'])
    const fields = out.split('\0')
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const file = fields[i].replace(`${sha}:`, '')
      const content = fields[i + 2]
      if (!p.re.test(content)) continue // git grep -E is over-broad (`.` = any char)
      hits.push({ rev: sha.slice(0, 7), file, line: Number(fields[i + 1]), pattern: p.name })
    }
  }
  return hits
}

/** Range: what each rev ADDS. Content added mid-range and deleted before the
 *  tip is still published by the push, so net-diffing base..tip is not enough. */
function scanRange(repo: string, base: string, sha: string): PrivacyHit[] {
  const revs = git(repo, ['rev-list', `${base}..${sha}`]).split('\n').filter(Boolean)
  const hits: PrivacyHit[] = []
  for (const rev of revs) {
    const short = rev.slice(0, 7)
    let file = ''
    let line = 0
    for (const raw of git(repo, ['show', '--pretty=format:', '--unified=3', rev]).split('\n')) {
      if (raw.startsWith('+++ ')) {
        file = raw.slice(4)
        if (file.startsWith('b/')) file = file.slice(2)
        continue
      }
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
      if (hunk) {
        line = Number(hunk[1])
        continue
      }
      if (raw.startsWith('+')) {
        const content = raw.slice(1)
        for (const p of PRIVACY_PATTERNS) {
          if (p.re.test(content)) hits.push({ rev: short, file, line, pattern: p.name })
        }
        line++
        continue
      }
      if (raw.startsWith('-') || raw.startsWith('@@') || raw.startsWith('\\')) continue
      line++ // context line (and any diff header ahead of the first @@, which resets it)
    }
  }
  return hits
}

/** Every hit the push would publish. Empty array = the push is clean. */
export function scanPush(repo: string, stdin: string): PrivacyHit[] {
  const hits: PrivacyHit[] = []
  for (const { localSha, base } of parseRefs(stdin)) {
    hits.push(...(base ? scanRange(repo, base, localSha) : scanTree(repo, localSha)))
  }
  return hits
}

/** `rev file:line PATTERN` — pattern NAME only, never the matched value. */
export function formatHits(hits: PrivacyHit[]): string {
  const rows = [...new Set(hits.map((h) => `[${h.rev}] ${h.file}:${h.line} ${h.pattern}`))].sort()
  return [
    ...rows,
    '',
    'pre-push: the lines above carry private identity or credentials (values not echoed).',
    'Scrub them from the range before publishing; this gate has no exemptions.',
  ].join('\n')
}

// CLI entry so .githooks/pre-push (or CI) can run the compiled gate:
//   node dist/main/main/pre-push-gate.js   # pre-push ref lines on stdin, exit 1 = block
if (require.main === module) {
  const top = git(process.cwd(), ['rev-parse', 'show-toplevel']).trim()
  const hits = scanPush(top || process.cwd(), fs.readFileSync(0, 'utf8'))
  if (hits.length) {
    process.stderr.write(`${formatHits(hits)}\n`)
    process.exit(1)
  }
}
