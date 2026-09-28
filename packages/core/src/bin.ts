#!/usr/bin/env node
import { main } from './cli'

main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code
})
