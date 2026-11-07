/**
 * The attempt tests of chatgpt.test.ts again, with the account's `procedures` set to `generic` (WW2-iii): the same
 * assertions, so the legacy driver and the generic Procedures are held to one behaviour. Belongs to `test:web`.
 */
process.env.WEB_PROCEDURES = 'generic'
// A query makes it a module of its own, so its tests register again; the specifier is not a literal for the type checker.
const again = './chatgpt.test.ts?procedures=generic'
await import(again)
