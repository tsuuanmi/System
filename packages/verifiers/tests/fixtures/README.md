# Verifier test fixtures

[floating-promise.ts](floating-promise.ts) is a deliberate
`no-floating-promises` violation (a promise dropped inside `try/finally`).
`eslint.config.js` ignores it; [lint.test.ts](../lint.test.ts) lints it with
`--no-ignore` and expects the failure.
