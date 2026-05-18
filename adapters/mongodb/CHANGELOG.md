# @payloadcms-vectorize/mongodb

## 0.7.4

### Patch Changes

- [#55](https://github.com/techiejd/payloadcms-vectorize/pull/55) [`b7862c7`](https://github.com/techiejd/payloadcms-vectorize/commit/b7862c77ba45a0867a337cf249c3cb8c8f71f511) Thanks [@techiejd](https://github.com/techiejd)! - Fix: reorder the vectorize task so existing chunks are deleted only after `toKnowledgePool` + embeddings succeed. Previously, a transient embedding-provider failure during re-vectorization would wipe a document's existing chunks before the new ones were ready, leaving the document temporarily unsearchable. Also documents a first-class Localization (i18n) pattern in the README.

- Updated dependencies [[`b7862c7`](https://github.com/techiejd/payloadcms-vectorize/commit/b7862c77ba45a0867a337cf249c3cb8c8f71f511)]:
  - payloadcms-vectorize@0.7.4

## 0.7.3

### Patch Changes

- [#52](https://github.com/techiejd/payloadcms-vectorize/pull/52) [`39076db`](https://github.com/techiejd/payloadcms-vectorize/commit/39076db031a224c46decf691eca7fe5569361895) Thanks [@techiejd](https://github.com/techiejd)! - Add `@payloadcms-vectorize/mongodb` adapter (Atlas + self-hosted Community 8.2+) backed by `$vectorSearch`, with pre/post filter splitting and full WHERE-clause parity across operators (equals, not_equals, in, notIn, like, contains, gt/gte/lt/lte, exists, and/or). Search indexes are auto-ensured on first use.

- Updated dependencies [[`39076db`](https://github.com/techiejd/payloadcms-vectorize/commit/39076db031a224c46decf691eca7fe5569361895)]:
  - payloadcms-vectorize@0.7.3
