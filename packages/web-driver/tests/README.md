# @system/web-driver tests

[engine.test.ts](engine.test.ts) and [heal.test.ts](heal.test.ts) are System 1's
UI engine specs on `node:test`: map loading and overlay, the readback diff, the
self-heal matcher. [driver.test.ts](driver.test.ts) runs the driver against
[fake-chatgpt.ts](fake-chatgpt.ts), System 1's stand-in for chatgpt.com (its
header lists the live traps it reproduces), in a headed Chrome on a private
Xvfb. [serve-fake-chatgpt.ts](serve-fake-chatgpt.ts) serves the fake from its
own process, for tests that block their event loop. The Runtime's attempts are
tested in [packages/agents/tests](../../agents/tests/README.md).
