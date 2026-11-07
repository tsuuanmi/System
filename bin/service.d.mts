export const MIN_NODE: string
export function nodeChoice(current: string, installed: string[]): { use: 'current' } | { use: 'other'; version: string } | { use: 'none' }
export function unitPath(homedir: string): string
export function unitText(options: { node: string; entry: string; home: string; path: string }): string
export function serviceMode(options: { home: string; homedir: string; platform: NodeJS.Platform; args: string[]; env: Record<string, string | undefined> }): 'install' | 'skip' | 'foreground'
export const UPGRADE_EXIT: 75
export function supervise(options: { run: () => Promise<number>; stopped: () => boolean; log: (line: string) => void }): Promise<number>
