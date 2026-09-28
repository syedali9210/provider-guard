import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFileSink, DEFAULT_RECORDS_FILE, type RecordSink } from './records'

/** Appends one JSON line per attempt. Node only; the directory is created on first write. */
export function fileSink(file: string = DEFAULT_RECORDS_FILE): RecordSink {
  return createFileSink(fs, path, path.resolve(file))
}

export type { RecordSink }
