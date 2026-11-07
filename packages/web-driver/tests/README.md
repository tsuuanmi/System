# @system/web-driver tests

[engine.test.ts](engine.test.ts) and [heal.test.ts](heal.test.ts) are System 1's
UI engine specs on `node:test`: map loading and overlay, the readback diff, the
self-heal matcher. [driver.test.ts](driver.test.ts) runs the driver against
[fake-chatgpt.ts](fake-chatgpt.ts), System 1's stand-in for chatgpt.com (its
header lists the live traps it reproduces), in a headed Chrome on a private
Xvfb. [serve-fake-chatgpt.ts](serve-fake-chatgpt.ts) serves the fake from its
own process, for tests that block their event loop. The fake's `modeSwitch`, `modeSwitchDelayMs`, `modeFlipToWorkMs`, `signOutAfterMs` and `challengeAfterMs` reproduce a switch that is late, absent, or changes, and a session that ends or a challenge that appears while it is awaited. The Runtime's attempts are
tested in [packages/web-worker/tests](../../web-worker/tests/README.md).

[conformance.ts](conformance.ts) is the Procedure contract as a suite over any map and
fake page; [conformance.test.ts](conformance.test.ts) runs it (headed Chrome, `test:web`) on
[fake-other.ts](fake-other.ts), an invented hostile Site (no temporary chat, no mode switch,
a plain textarea, a status element instead of a Stop button, its error inside the answer, the
code label above the code, a long paste kept as a file chip labelled by its text), and on ChatGPT's map and fake. [procedures-map.test.ts](procedures-map.test.ts)
(unit, no Chrome) is the `ui-map@1.7` schema and validation.
