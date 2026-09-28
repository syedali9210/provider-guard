// Packs packages/core, installs the tarball into a fresh temp project, and checks
// that the bin and both module formats load. Cross-platform: no shell syntax.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const coreDir = join(import.meta.dirname, '..', 'packages', 'core')
const { version } = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'))
const tmp = mkdtempSync(join(tmpdir(), 'pg-smoke-'))

// pnpm/npm/npx are .cmd shims on Windows and need a shell; node does not.
function run(cmd: string, args: string[], cwd: string): string {
  const shell = process.platform === 'win32' && cmd !== process.execPath
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell })
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${res.status}):\n${res.stdout}\n${res.stderr}`,
    )
  }
  return res.stdout.trim()
}

try {
  run('pnpm', ['pack', '--pack-destination', tmp], coreDir)
  const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error('pnpm pack produced no tarball')

  const app = join(tmp, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), '{ "name": "smoke", "private": true }\n')
  writeFileSync(join(app, 'esm.mjs'), "await import('provider-guard')\n")
  writeFileSync(join(app, 'cjs.cjs'), "require('provider-guard')\nrequire('provider-guard/node')\n")
  run('npm', ['install', '--no-audit', '--no-fund', join('..', tarball), 'ai@7'], app)

  const out = run('npx', ['--no-install', 'provider-guard', '--version'], app)
  if (out !== version) throw new Error(`expected --version to print ${version}, got "${out}"`)
  run(process.execPath, ['esm.mjs'], app)
  run(process.execPath, ['cjs.cjs'], app)

  // The main entry must stay loadable in Edge runtimes: no static imports or requires at all.
  for (const file of ['index.js', 'index.cjs']) {
    const code = readFileSync(join(app, 'node_modules', 'provider-guard', 'dist', file), 'utf8')
    if (/^import\s|require\(/m.test(code)) throw new Error(`dist/${file} imports a module`)
  }
  console.log(`smoke ok: provider-guard@${version}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
