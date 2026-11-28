import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** `$DSH_HOME`: the launcher's home resolver when present. */
export function dshHome(ctx: Context): string {
  const homePath = ctx.get('dshHomePath' as never) as ((...s: string[]) => string) | undefined
  return homePath ? homePath() : process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** `$DSH_HOME/system/...`: the launcher's home resolver when present. */
export function systemPath(ctx: Context, ...segments: string[]): string {
  const homePath = ctx.get('dshHomePath' as never) as ((...s: string[]) => string) | undefined
  return homePath ? homePath('system', ...segments) : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'system', ...segments)
}
