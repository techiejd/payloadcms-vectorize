# @payloadcms-vectorize/cf

## 0.7.2

### Patch Changes

- [#46](https://github.com/techiejd/payloadcms-vectorize/pull/46) [`664b2b6`](https://github.com/techiejd/payloadcms-vectorize/commit/664b2b6965d8b9a80f315042fbdd4cd97a793dca) Thanks [@stevenlafl](https://github.com/stevenlafl)! - Fix missing TypeScript declarations in `@payloadcms-vectorize/pg` and `@payloadcms-vectorize/cf`. The build now runs `tsc` before SWC so `dist/index.d.ts` is actually emitted, and both adapters expose modern conditional `exports` with a types-first condition.

- Updated dependencies [[`664b2b6`](https://github.com/techiejd/payloadcms-vectorize/commit/664b2b6965d8b9a80f315042fbdd4cd97a793dca)]:
  - payloadcms-vectorize@0.7.2

## 0.7.0

### Patch Changes

- Fix CF adapter hasEmbeddingVersion ignoring version param, escape regex in like operator, handle empty WHERE in PG adapter, remove to-snake-case from root package.

- Updated dependencies []:
  - payloadcms-vectorize@0.7.0
