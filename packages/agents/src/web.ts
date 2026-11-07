/**
 * The seam to the web Runtime (WW2a). `chatgpt-web` accounts are configured in the `agents` row but served by the
 * optional `web-worker` row (`@system/web-worker`), which provides this service; with the row off the accounts are
 * reported unavailable. Only types and one message live here: nothing of the browser is loaded.
 */

/** The `chatgpt-web` settings of an account entry; the web-worker row validates them and fills the defaults. */
export interface WebAccountSettings {
  /** The Chrome profile (the signed-in session), relative to $DSH_HOME/system unless absolute; default `chatgpt-web/<name>`. */
  profileDir?: string
  /** Open each attempt in a temporary chat (default true). */
  temporaryChat?: boolean
  /** The page to open (default https://chatgpt.com/). */
  url?: string
  /** The Chrome to drive; default `CHROME_PATH`, a system Chrome as new as the engine's Chromium, else the pinned Chrome for Testing, installed under $DSH_HOME/system/browsers on first use. */
  executablePath?: string
  /** Seconds per stage (`load`, `answer`, `launch`, `mode`, `attach`) and how long the answer's text must stay unchanged (`stable`). */
  timeouts?: Partial<Record<'load' | 'answer' | 'stable' | 'launch' | 'mode' | 'attach', number>>
  /** Characters (whitespace ignored) the answer may hold outside its output blocks (default 200); more fails the attempt, as an output may be cut short. */
  maxOutsideChars?: number
  /** The page logic of an attempt: `legacy` (System 1's ChatGPT driver, default) or `generic` (the generic Procedures bound to the ChatGPT map); anything else is refused. */
  procedures?: 'legacy' | 'generic'
}

/** An account entry as the `agents` row hands it over: its offered capabilities (tiers included) and its limits resolved. */
export interface WebRegistration extends WebAccountSettings {
  ref: string
  capabilities: string[]
  attemptTimeoutMinutes?: number
  maxConcurrentAttempts?: number
}

export interface LoginReport {
  signedIn: boolean
  detail: string
  imported?: number
  skipped?: number
}

/** Where to reach a remote sign-in's viewer, and until when. */
export interface RemoteView {
  url: string
  port: number
  ssh: string
  expiresAt: number
}

/** `ctx.webWorker`, provided by the `web-worker` row. */
export interface WebWorkerService {
  /** Check a `chatgpt-web` account and register it as a Worker; rejects with the reason it is unavailable. The registration ends with `dispose`. */
  register(account: WebRegistration): Promise<{ command: string; version: () => Promise<string>; dispose: () => void }>
  /** Announce that the account's registration is in progress and ends with `done`: an operation on it waits, bounded, for it, and a rejection is its refusal reason. */
  expect(ref: string, done: Promise<unknown>): void
  /** Sign a registered account in, by the contents of a cookie file or by hand in a window (needs a display). */
  login(ref: string, cookies: string | undefined): Promise<LoginReport>
  /** Start a remote sign-in (the viewer on 127.0.0.1, behind a token); one per account at a time. */
  loginRemote(ref: string): Promise<RemoteView>
  /** Wait for the account's remote sign-in to end (Save, Cancel or expiry), or with `cancel` end it now, and report. */
  loginWait(ref: string, cancel: boolean): Promise<LoginReport>
}

/** The reason of a `chatgpt-web` account, and of a login, when the row is off. */
export const WEB_WORKER_DISABLED = 'the web-worker row is disabled'
