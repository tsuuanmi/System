/**
 * The scripted `fakes` plugin is not in the shipped bundle: a test that needs it inserts the row through its own profile patch.
 * `withFakes` is that patch, so no test writes the row itself.
 */

export interface FakesConfig {
  workers: string[]
  verifiers?: string[]
  effects?: string[]
}

/** A profile patch that turns the real `verifiers` and `effects` rows off and inserts `fakes` with `config` (YAML flow lists, as the tests wrote them). */
export function withFakes(config: FakesConfig): string {
  const lines = Object.entries(config).map(([key, list]) => `        ${key}: [${(list as string[]).join(', ')}]`)
  return `- id: verifiers
  disabled: true
- id: effects
  disabled: true
- insert:
    - id: fakes
      name: '@system/fakes'
      config:
${lines.join('\n')}
`
}
