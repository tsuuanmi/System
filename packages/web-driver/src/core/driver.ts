// Ported from System 1 (tsuuanmi/system @ f199a277): packages/provider-core/src/driver.ts. Changes: packages/web-driver/README.md.
/**
 * The types the driver and the UI engine share (ADR-0005, docs/design/provider-turns.md#driver-interface):
 * the sign-in state, a conversation's snapshot, the options of `open` and of a deletion. The driver contract
 * itself (`ProviderDriver`) went with the legacy turn.
 */

/** What the provider page shows now: the last assistant response and whether it is generating. */
export interface TurnSnapshot {
  text: string
  running: boolean
  /** False when the conversation cannot be observed (temporary, never bound, or not rendered): never resend blind. */
  observable?: boolean
  /** Text of the conversation's last user turn, as shown. */
  lastPrompt?: string
}

export type AuthState = 'signed-in' | 'signed-out' | 'unknown'
export type ConversationMode = 'temporary' | 'persistent'

export type ProviderFeature = 'chat' | 'deep-research' | 'web-search'

/** What `open` needs of a conversation: temporary or persistent, and the persistent one to continue. */
export interface OpenOptions {
  conversation: ConversationMode
  /** Persistent conversation to continue. */
  binding?: string | undefined
}

/** How one deletion runs (PROP-0004 Phase 5). */
export interface DeleteOptions {
  /** Called once, immediately before the irreversible confirm; a throw confirms nothing. */
  beforeConfirm?: () => void | Promise<void>
  /** A confirm was already recorded for it: only check that it is gone, and never click again. */
  confirmed?: boolean
}
