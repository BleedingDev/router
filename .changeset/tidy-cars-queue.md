---
'@tanstack/router-core': patch
'@tanstack/solid-router': patch
---

Queue Solid resource serialization until client adapters initialize, and retain those adapters until rendering finishes without delaying other renderers' hydration fast paths.
