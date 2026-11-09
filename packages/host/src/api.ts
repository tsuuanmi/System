/**
 * The API reference of the README, written from the operation table so it
 * cannot drift: a test fails when the README differs from this output.
 */
import { z } from '@system/work'
import type { Methods } from './index.ts'

interface Shape {
  type?: string
  enum?: unknown[]
  anyOf?: Shape[]
  items?: Shape
  properties?: Record<string, Shape>
  required?: string[]
}

/** `{ name: type, other?: type }` for an object's properties. */
const fieldsOf = (shape: Shape): string => Object.entries(shape.properties ?? {}).map(([name, field]) => `${name}${shape.required?.includes(name) ? '' : '?'}: ${typeOf(field)}`).join(', ')

const typeOf = (shape: Shape): string => {
  if (shape.enum) return shape.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (shape.anyOf) return shape.anyOf.map(typeOf).join(' | ')
  if (shape.type === 'object' && shape.properties) return `{ ${fieldsOf(shape)} }`
  if (shape.type === 'array') return `${typeOf(shape.items ?? {})}[]`
  return shape.type ?? 'any'
}

/** `name: type`, with `?` after the name of an optional param; `none` for a row without params. */
function paramsOf(shape: Shape | undefined): string {
  if (!shape || !Object.keys(shape.properties ?? {}).length) return 'none'
  return Object.entries(shape.properties!).map(([name, param]) => `\`${fieldsOf({ properties: { [name]: param }, required: shape.required?.includes(name) ? [name] : [] })}\``).join(', ')
}

/** `host.hello` is answered by the connection itself, before the table. */
const HELLO = { agent: true, params: '`version: string`, `caller: { type: "human" | "agent", operatorId: string }`', summary: 'The first request of a connection: `{ version, packageVersion }`.' }

/** One table row per method: its agent flag, its params and what it does. */
export function apiReference(methods: Methods): string {
  const rows: [string, boolean, string, string][] = [['host.hello', HELLO.agent, HELLO.params, HELLO.summary]]
  for (const [name, method] of Object.entries(methods)) {
    const shape = method.params ? z.toJSONSchema(method.params, { io: 'input' }) as Shape : undefined
    rows.push([name, method.agent, paramsOf(shape), method.summary ?? ''])
  }
  return ['| Method | Agent | Params | Result |', '| --- | --- | --- | --- |', ...rows.map(([name, agent, params, summary]) => `| \`${name}\` | ${agent ? 'yes' : 'no'} | ${params.replaceAll('|', '\\|')} | ${summary.replaceAll('|', '\\|')} |`)].join('\n')
}
