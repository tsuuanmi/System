/** The Accounts `system workers` shows, read from a `Capabilities` registry the way the Host reads it (ADR-0018 decision 1). */
import { Capabilities, type WorkerPort } from '../packages/work/src/registry.ts'

/** A real registry that tells `onWorker` of each Worker registered into it. */
export function observed(onWorker?: (worker: WorkerPort) => void): Capabilities {
  const capabilities = new Capabilities()
  const register = capabilities.registerWorker.bind(capabilities)
  capabilities.registerWorker = (worker) => { onWorker?.(worker); return register(worker) }
  return capabilities
}

/** The listed Accounts (status and version, no quota read) and one Account's quota. */
export function viewOf(capabilities: Capabilities) {
  return {
    accounts: () => capabilities.statuses(),
    quota: (ref: string) => capabilities.quotaOf(ref),
  }
}
