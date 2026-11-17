export interface UpdateDeps {
  install: string
  cli: string
  origin: string
  run(command: string, args: string[], cwd?: string): Promise<{ status: number; stdout: string }>
  write(path: string, text: string): void
  read(path: string): string | undefined
  remove(path: string): void
  exists(path: string): boolean
  readlink(path: string): string | undefined
  switchLink(path: string, target: string): void
  releases(): string[]
  probe(release: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
  log(line: string): void
  waitMs: number
}
export function update(deps: UpdateDeps): Promise<number>
export const PENDING: string
export interface FinishDeps {
  run: UpdateDeps['run']
  read: UpdateDeps['read']
  write: UpdateDeps['write']
  remove: UpdateDeps['remove']
  switchLink: UpdateDeps['switchLink']
  log: UpdateDeps['log']
}
export function finishInstallCheck(deps: FinishDeps & { install: string }): Promise<boolean>
export function finishPending(deps: FinishDeps & { install: string; commit: string; alive(pid: number): boolean }): Promise<number>
