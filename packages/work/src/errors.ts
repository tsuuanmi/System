/** A refusal or failure the operator should read: admission, run, cancel, retry, decide. */
export class WorkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkError'
  }
}
