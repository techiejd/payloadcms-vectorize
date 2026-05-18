# Vectorize Task Safety Reorder + Localization Docs

**Date:** 2026-05-13
**Status:** Design
**Topic:** Two small, independently-valuable changes split off from the parked scope-aware-chunk-identity spec. Ship together because they share a release story.

## Background

A separate brainstorming session (see [archive/2026-05-10-scope-aware-chunk-identity.md](archive/2026-05-10-scope-aware-chunk-identity.md)) explored generalizing the locale-scoping problem into a first-class `scopeKey` config. We concluded that full feature is YAGNI for now: the locale case (the dominant motivator) is already solvable with the existing extension-field + `where` pattern, and the remaining motivators (draft/published with locale, per-tenant isolation, A/B variants) are rare enough to defer until a user reports the gap.

Two pieces of that work are valuable on their own and ship here:

1. The **vectorize task reorder** is a general safety improvement, unrelated to scope.
2. The **README "Localization" section** turns the existing capability into a discoverable feature and neutralizes competitor positioning that markets "locale-scoped semantic search" as a differentiator.

A third small piece — a **Roadmap line** about scope-aware identity — converts the parked spec into a market-research signal: if users file issues citing it, that surfaces real demand and unparks the spec.

## Change 1: Vectorize Task Reorder

### Problem

`src/tasks/vectorize.ts` currently runs in this order:

```
deleteChunks  →  toKnowledgePool  →  validateChunkData  →  embed  →  storeChunk
```

The destructive step (`deleteChunks`) happens first. Any failure in `toKnowledgePool`, validation, or the external embedding API leaves the doc with **no embeddings at all** until someone fixes the underlying issue and re-triggers. The most common real-world cause is a transient embedding-provider failure (rate limit, network blip, malformed input), which silently wipes a doc's chunks until the next save.

### Fix

Reorder to:

```
toKnowledgePool  →  validateChunkData  →  embed  →  deleteChunks  →  storeChunk
```

The destructive step now runs only after we have valid embeddings ready to insert. A rate-limit error fails the task without touching the DB; the next retry rebuilds cleanly with the existing chunks intact in the meantime.

Concretely, in [src/tasks/vectorize.ts:83-123](src/tasks/vectorize.ts#L83-L123), move the `await adapter.deleteChunks(...)` call from before `toKnowledgePoolFn(...)` to just before the `Promise.all` over `storeChunk(...)`.

### Residual gap (out of scope)

A window between `deleteChunks` and the end of the `storeChunk` `Promise.all` still allows partial failures to leave the doc partially-embedded. Closing this fully needs an adapter-level transaction across delete+store. That is a separate, larger change; the reorder alone removes the much more common failure mode (pre-delete failures) at near-zero cost.

### Bulk embed path

[src/tasks/bulkEmbedAll.ts](src/tasks/bulkEmbedAll.ts) uses [src/utils/deleteDocumentEmbeddings.ts](src/utils/deleteDocumentEmbeddings.ts) at batch-completion time. The same reorder principle applies: the delete should happen only after the batch result has been validated and the embeddings are ready to write. Planning phase should map the exact call site; the change is conceptually identical to the per-doc path.

## Change 2: README "Localization" Section

### Problem

A Payload developer evaluating vector-search plugins wants to know whether the plugin supports multi-locale content. Today's README has no "Localization" anchor in the TOC, no example, no mention of the `where` filter pattern for locale-aware search. A reasonable evaluator concludes the plugin doesn't support i18n and chooses a competitor that markets the feature explicitly — even though the underlying capability is identical.

### Fix

Add a new top-level section between [Chunkers](README.md#chunkers) and [Bulk Embeddings API](README.md#bulk-embeddings-api), titled **"Localization (i18n)"**, that walks through the recommended pattern end-to-end:

1. **Declare `locale` as a required extension field** on the knowledge pool.
2. **Iterate locales inside `toKnowledgePool`**, returning all-locale chunks tagged with `locale`. Provide a working snippet using `payload.findByID({ locale })`.
3. **Filter at search time** with `where: { locale: { equals: req.locale } }` (link to the existing [Metadata Filtering](README.md#metadata-filtering-where) section).
4. **Note the tradeoff**: every edit re-embeds every locale together. For most CMS workloads this is a non-issue (edits are infrequent, embeddings are cheap). If a user's workflow can't tolerate this, point them at the Roadmap line (Change 3) to file an issue.

Add the section to the TOC at line 36 (between `Metadata Filtering` and `Chunkers`) and add a Features bullet near the top of the README so the capability is discoverable from the first scroll. Suggested bullet: `🌍 **Localization (i18n)** — first-class pattern for embedding and searching multi-locale Payload content.`

The section is ~50 lines of prose plus the snippet. Self-contained; no other README rewrites required.

## Change 3: Roadmap Signal for Scope-Aware Identity

### Problem

The parked spec is a complete design for a real-but-niche capability. Burying it in the archive folder means we never hear from the users who would benefit. We want a low-cost mechanism that surfaces real demand without committing to build.

### Fix

Add one line to the **Help wanted** subsection of [README.md#roadmap](README.md#roadmap) (around line 1021-1025):

> - **Scope-aware chunk identity** — `(sourceCollection, docId, …scopeFields)` as identity for advanced editorial workflows: draft/published with locale, per-tenant isolation, A/B variants. Design is drafted (see `docs/plans/archive/`). Waiting on a real use case before building — open an issue if this would unblock you.

This converts the parked spec into a market-research instrument. Issues citing it go straight to the prioritization queue, and the link to the archived design gives interested users (and future-us) a starting point.

## Out of Scope

- The `scopeKey` config field, contract redesign, per-scope delete-and-replace algorithm, and adapter changes. All preserved in the archived spec; deferred pending user demand.
- Adapter-level transactions across delete+store.
- Backfill tooling for any future scope-key opt-in.

## Testing

**Change 1 (reorder):**

- New integration test in `dev/specs/`: vectorize a doc, then trigger another vectorize where `realTimeIngestionFn` is mocked to throw. Assert that the existing chunks for the doc are still present after the failure. (This is the test that exercises the bug the reorder fixes; it should fail on the current `main` and pass after the change.)
- Re-run existing vectorize specs to confirm no regression for the happy path.

**Changes 2 and 3 (README only):**

- No code tests. Manual review of rendered Markdown (GitHub preview) before merge to verify the TOC anchor resolves and the snippet is copy-pasteable.

## Release Notes

- Patch or minor bump (no API change). Changelog entry framing:
  > **Vectorize task safety:** embedding-provider failures no longer wipe a doc's existing embeddings. The vectorize task now generates, validates, and embeds chunks before deleting the old chunk-set, so transient errors leave the previous chunks intact for the next retry.
  >
  > **Localization docs:** new README section covers the recommended pattern for embedding and searching multi-locale Payload content using extension fields and the existing `where` filter.
