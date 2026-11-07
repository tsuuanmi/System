# The ChatGPT UI map

[chatgpt-web.ui.yaml](chatgpt-web.ui.yaml) is System 1's map of chatgpt.com
(`ui-map@1.6`, last checked against the live site by System 1 on 2026-10-11):
elements with ordered candidates, actions with postconditions, states,
passive network signals and error rules. A site change is a change here. `answer.site-error` is the site's own error inside the newest answer (WW6a), polled during the wait.
[ui-map.v1.json](ui-map.v1.json) is the schema it is loaded against. `settings` (added here, `ui-map@1.5`) holds the site's own clocks: how long the mode switch may take to render and how long its mode must hold. `attachMinChars`, `attachWaitMs` and `attachLabelChars` (`ui-map@1.6`) are the attach-text Procedure's: the size under which a prompt stays one part, how long a pasted body may take to settle, and how much of it a chip's label must start with.
