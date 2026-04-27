---
"payloadcms-vectorize": patch
"@payloadcms-vectorize/pg": patch
"@payloadcms-vectorize/cf": patch
"@payloadcms-vectorize/mongodb": patch
---

Add `@payloadcms-vectorize/mongodb` adapter (Atlas + self-hosted Community 8.2+) backed by `$vectorSearch`, with pre/post filter splitting and full WHERE-clause parity across operators (equals, not_equals, in, notIn, like, contains, gt/gte/lt/lte, exists, and/or). Search indexes are auto-ensured on first use.
