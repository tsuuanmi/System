export const MIN_NODE: string
export function nodeChoice(current: string, installed: string[]): { use: 'current' } | { use: 'other'; version: string } | { use: 'none' }
export function unitPath(homedir: string): string
export function unitOverlays(text: string): string[]
export function unitText(options: { node: string; entry: string; home: string; path: string; patch?: string }): string
export function installRoot(repo: string, exists: (path: string) => boolean): string
export function serviceMode(options: { home: string; homedir: string; platform: NodeJS.Platform; args: string[]; env: Record<string, string | undefined> }): 'install' | 'skip' | 'foreground'
export const UPGRADE_EXIT: 75
export const UPGRADE_RETRIES: number
export function supervise(options: { run: () => Promise<number>; stopped: () => boolean; log: (line: string) => void; wait?: (ms: number) => Promise<void> }): Promise<number>
export function hostCommand(args: string[]): boolean
export function installProfile(repo: string, exists: (path: string) => boolean): string | undefined
export function schedulesDir(installBase: string): string
export function scheduleServiceText(options: { name: string; node: string; entry: string; home: string; path: string; file: string }): string
export function scheduleTimerText(options: { name: string; at: string[] }): string
export function scheduleUnits(options: { node: string; entry: string; home: string; path: string; schedules: { name: string; file: string; at: string[]; checkAt?: string }[] }): Map<string, string>
export function syncScheduleUnits(dir: string, wanted: Map<string, string>, keep: string[]): { written: string[]; removed: string[] }
