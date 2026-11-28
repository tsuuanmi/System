/**
 * A Schedule (ADR-0020 decision 6; GLOSSARY Schedule): the file `~/.system/schedules/<name>.yaml` that says
 * when a Scheduled session starts and what it carries. `kind: items` carries the Ready Items of named
 * repositories; `kind: work` is accepted by the format and refused here until the first real use exists.
 * Times are systemd calendar expressions, checked with `systemd-analyze calendar` when it is on the PATH.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parse } from 'yaml'

export interface ItemsSchedule {
  kind: 'items'
  repositories: string[]
  at: string[]
  maxParallel?: number
  checkAt?: string
}

export interface ScheduleOptions {
  /** Check one calendar expression: undefined when it is fine (or cannot be checked), else the complaint. */
  calendar?: (expression: string) => string | undefined
}

/** `systemd-analyze calendar <expression>`; nothing is said when the tool is not installed. */
export function checkCalendar(expression: string): string | undefined {
  const ran = spawnSync('systemd-analyze', ['calendar', expression], { encoding: 'utf8' })
  if (ran.error || ran.status === 0) return undefined
  return (ran.stderr || ran.stdout).trim().split('\n')[0] || `exit ${ran.status}`
}

const KEYS = new Set(['kind', 'repositories', 'at', 'maxParallel', 'checkAt'])

function expression(value: unknown, field: string, calendar: (e: string) => string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is a systemd calendar expression (a non-empty string)`)
  const complaint = calendar(value)
  if (complaint) throw new Error(`${field}: "${value}": ${complaint}`)
  return value
}

/** Parse the text of a Schedule file; throws an Error that says what is wrong. */
export function parseSchedule(text: string, options: ScheduleOptions = {}): ItemsSchedule {
  const calendar = options.calendar ?? checkCalendar
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    throw new Error(`not YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('a Schedule is a YAML mapping')
  const map = data as Record<string, unknown>
  if (map.kind === 'work') throw new Error('kind: work is not built yet (a Schedule carries Items: kind: items)')
  if (map.kind !== 'items') throw new Error('kind is `items` (or `work`, not built yet)')
  for (const key of Object.keys(map)) if (!KEYS.has(key)) throw new Error(`unknown key ${key}`)
  const repos = map.repositories
  if (!Array.isArray(repos) || repos.length === 0 || repos.some((r) => typeof r !== 'string' || !r)) {
    throw new Error('repositories is a non-empty list of paths')
  }
  const repositories = (repos as string[]).map((path) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path))
  for (const path of repositories) if (!isAbsolute(path)) throw new Error(`repositories: "${path}" is not an absolute path (or ~/...)`)
  const list = typeof map.at === 'string' ? [map.at] : map.at
  if (!Array.isArray(list) || list.length === 0) throw new Error('at is one or more systemd calendar expressions')
  const at = list.map((value) => expression(value, 'at', calendar))
  const schedule: ItemsSchedule = { kind: 'items', repositories, at }
  if (map.maxParallel !== undefined) {
    if (typeof map.maxParallel !== 'number' || !Number.isInteger(map.maxParallel) || map.maxParallel < 1) throw new Error('maxParallel is a positive integer')
    schedule.maxParallel = map.maxParallel
  }
  if (map.checkAt !== undefined) schedule.checkAt = expression(map.checkAt, 'checkAt', calendar)
  return schedule
}

/** Read and parse a Schedule file; an error names the file. */
export function readSchedule(file: string, options: ScheduleOptions = {}): ItemsSchedule {
  const expanded = file === '~' || file.startsWith('~/') ? join(homedir(), file.slice(1)) : file
  let text: string
  try {
    text = readFileSync(expanded, 'utf8')
  } catch (error) {
    throw new Error(`${expanded}: ${(error as Error).message}`)
  }
  try {
    return parseSchedule(text, options)
  } catch (error) {
    throw new Error(`${expanded}: ${(error as Error).message}`)
  }
}
