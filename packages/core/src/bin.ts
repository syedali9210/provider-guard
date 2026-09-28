#!/usr/bin/env node
import { main } from './cli'
import { createStudioCommand } from './studio'

main(
  process.argv.slice(2),
  { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() },
  createStudioCommand(),
).then((code) => {
  process.exitCode = code
})
