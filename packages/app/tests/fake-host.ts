import type { HostClient, Method, Params } from '../src/remote.ts'

/** What a fake Host answers per table row; a row not listed fails the test that calls it. */
export type Answers = { [M in Method]?: (params: Params<M>) => unknown }

/** A `HostClient` for the CLI's tests, through its interface: the rows it answers, and the flows it implements. */
export function fakeHost(answers: Answers = {}, flows: Partial<Omit<HostClient, 'call'>> = {}): HostClient {
  const missing = (name: string) => async (): Promise<never> => { throw new Error(`the fake Host has no ${name}`) }
  return {
    async call(method, params) {
      const answer = answers[method] as ((params: Params<typeof method>) => unknown) | undefined
      if (!answer) throw new Error(`the fake Host has no answer for ${method}`)
      return await answer(params) as never
    },
    run: flows.run ?? missing('run'),
    retry: flows.retry ?? missing('retry'),
    decide: flows.decide ?? missing('decide'),
    wait: flows.wait ?? missing('wait'),
    waitFor: flows.waitFor ?? missing('waitFor'),
    loginRemote: flows.loginRemote ?? missing('loginRemote'),
  }
}
