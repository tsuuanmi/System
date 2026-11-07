# The ChatGPT UI map

[chatgpt-web.ui.yaml](chatgpt-web.ui.yaml) is System 1's map of chatgpt.com
(`ui-map@1.7`, last checked against the live site by System 1 on 2026-10-11):
elements with ordered candidates, actions with postconditions, states,
passive network signals and error rules. A site change is a change here. `answer.site-error` is the site's own error inside the newest answer (WW6a), polled during the wait.
[ui-map.v1.json](ui-map.v1.json) is the schema it is loaded against. `settings` (added here, `ui-map@1.5`) holds the site's own clocks: how long the mode switch may take to render and how long its mode must hold. `attachMinChars`, `attachWaitMs` and `attachLabelChars` (`ui-map@1.6`) are the attach-text Procedure's: the size under which a prompt stays one part, how long a pasted body may take to settle, and how much of it a chip's label must start with. `answer.leakedTokens` (`ui-map@1.7`) lists the control tokens the site leaks into its text, removed at an output's start and end. `site`, `modes`, the rest of `answer` and the new settings (`ui-map@1.7`, WW2-ii) are what the generic Procedures bind to; the ChatGPT driver does not read them yet. [fake-other.ui.yaml](fake-other.ui.yaml) is the map of an invented hostile Site used to prove that a map and a page are enough.
