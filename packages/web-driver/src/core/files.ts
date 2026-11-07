// Ported from System 1 (tsuuanmi/system @ f199a277): packages/libs/src/files.ts (`ensurePrivateDir`, `fsyncDir`, `writeFileDurable` and its temp file). Changes: packages/web-driver/README.md.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Create `dir` (and parents) owner-only, and refuse a group/world-accessible existing directory. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = statSync(dir)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} must not be accessible by group or others (mode ${(stat.mode & 0o777).toString(8)})`)
  }
}

/** fsync a directory so a rename or link inside it survives power loss (no-op where unsupported). */
export function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeTemp(path: string, data: string | Uint8Array, mode: number): string {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    if (typeof data === 'string') writeSync(fd, data)
    else writeSync(fd, data)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(temp)
    throw error
  }
  closeSync(fd)
  return temp
}

/**
 * Durably replace `path`: exclusive temp file with `mode`, fsync, rename, fsync the
 * directory. The temp file is removed on any failure. (DSH's writeFileAtomic leaves
 * crash durability out of scope, which the vault and the discovery file need.)
 */
export function writeFileDurable(path: string, data: string | Uint8Array, mode = 0o600): void {
  const temp = writeTemp(path, data, mode)
  try {
    renameSync(temp, path)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
  fsyncDir(dirname(path))
}
