---
"payloadcms-vectorize": patch
"@payloadcms-vectorize/pg": patch
"@payloadcms-vectorize/cf": patch
---

Fix missing TypeScript declarations in `@payloadcms-vectorize/pg` and `@payloadcms-vectorize/cf`. The build now runs `tsc` before SWC so `dist/index.d.ts` is actually emitted, and both adapters expose modern conditional `exports` with a types-first condition.
