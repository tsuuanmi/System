export interface UpdateDeps {
  install: string
  cli: string
  origin: string
  run(command: string, args: string[], cwd?: string): Promise<{ status: number; stdout: string }>
  write(path: string, text: string): void
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
