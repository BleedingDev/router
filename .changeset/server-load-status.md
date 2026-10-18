---
'@tanstack/router-core': patch
'@tanstack/start-server-core': patch
---

Keep server routers pending until every active load settles, including same-URL reloads, overlapping loads, and loads started by lifecycle callbacks.

Wait for active server loads before capturing hydration state and honor redirects that complete during that wait.

Observe loads started while custom dehydration remains pending, including after the hook yields, so an unrelated hook promise cannot block redirects, load failures, or settled route hints.

Fail SSR when any active server load throws, including a lifecycle-started load whose returned promise the application catches. Preserve early hints before custom dehydration hooks; a hook-started load may emit additional hints, and a later redirect cannot retract hints already sent.

Keep Web SSR declarations portable and expose Node pipeable transforms through the Node condition and explicit Node entries. Node TypeScript consumers, including React, Solid and Vue Start server consumers, use NodeNext resolution or Bundler resolution with `customConditions: ['node']`. Bundler without the Node condition selects the portable Web API.
