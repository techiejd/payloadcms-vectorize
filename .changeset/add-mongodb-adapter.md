---
"payloadcms-vectorize": minor
"@payloadcms-vectorize/pg": minor
"@payloadcms-vectorize/cf": minor
"@payloadcms-vectorize/mongodb": minor
---

Add `@payloadcms-vectorize/mongodb` adapter (Atlas + self-hosted Community 8.2+) backed by `$vectorSearch`, with pre/post filter splitting and full WHERE-clause parity across operators (equals, not_equals, in, notIn, like, contains, gt/gte/lt/lte, exists, and/or). Search indexes are auto-ensured on first use.
