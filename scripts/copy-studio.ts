// Copies the built Studio into the published core package (dist/studio), so users install nothing
// extra. Runs after both packages are built.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const from = join(root, 'packages', 'studio', 'dist')
const to = join(root, 'packages', 'core', 'dist', 'studio')

if (!existsSync(join(from, 'index.html'))) {
  throw new Error('No Studio build found. Run pnpm --filter @provider-guard/studio build first.')
}
rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true })
console.log(`Copied the Studio build to ${to}`)
