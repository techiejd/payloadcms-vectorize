# Scope-Aware Chunk Identity

**Date:** 2026-05-10
**Status:** Parked (archived 2026-05-13) — see note below
**Topic:** Generalize the locale-scoping problem so a single source document can produce multiple independent chunk-sets along any user-declared dimension (locale, draft/published, tenant, version, audience), without re-embedding one slice wiping the others.

---

> **Archive note (2026-05-13)**
>
> This spec is preserved as a complete design but is **not scheduled for implementation**. After reviewing the actual use-case prevalence in the Payload ecosystem, we concluded that the locale case (the dominant motivator) is already solvable via the existing extension-field + `where` pattern — see the "Localization" section added to the README. The remaining motivator (draft/published with locale, per-tenant isolation, A/B variants) is real but rare enough that we are waiting for a user-filed issue before building.
>
> The **vectorize task reorder** described in this spec's "Vectorize Task Algorithm" section has independent value and has been extracted to [2026-05-13-vectorize-safety-and-localization-docs.md](../2026-05-13-vectorize-safety-and-localization-docs.md). That ships separately.
>
> When a user reports a workflow that requires scope isolation, revive this spec, re-validate the design against the reported use case, and proceed to writing-plans. The recommended shape at revival time is the **additive** variant (Alternative 2 in the brainstorming session): `scope?` optional everywhere, no breaking change. The "required-but-empty" purity in the design below should be relaxed at that point.

## Problem

The plugin currently keys every chunk-set on `(sourceCollection, docId)`. This assumes one source doc produces one chunk-set. Re-embedding always wipes everything for that doc and re-inserts.

That assumption breaks for any source doc that fans out into independent slices:

- A localized doc with `en`, `es`, `fr` chunks. Re-embedding `en` today wipes the `es` and `fr` chunks.
- Draft vs. published. Re-embedding the published version wipes the draft's embeddings.
- Per-tenant variants of the same source.
- A/B variants, region variants, audience variants.

Today this is a latent bug for anyone using draft/published Payload collections; nobody has hit it yet because nobody has wired up locale-aware embeddings.

## Mental Model

A chunk-set has three kinds of data:

1. **Identity.** What the chunk-set "is": the flat tuple `(sourceCollection, docId, ...scopeFields)`. With `scopeKey: ['locale']`, identity becomes `(sourceCollection, docId, locale)`. With `scopeKey: ['locale', 'tenant']`, it becomes `(sourceCollection, docId, locale, tenant)`. Two chunk-sets that share `(sourceCollection, docId)` but differ on any scope field are independent and never collide.
2. **Scope.** Carried through the framework as `scope: Record<string, any>`, e.g. `{ locale: 'en', tenant: 'acme' }`. The keys come from the pool's `scopeKey` declaration. The values come from each chunk's extension fields. Semantically, scope spreads into the composite primary key; the `Record` is just the wire format because the keys are pool-defined and dynamic.
3. **Metadata.** Everything else in `extensionFields`. Queryable, displayable in admin, but not part of identity. Re-embedding does not key on metadata.

**Invariant:** every adapter operation on a chunk-set keys on the full identity tuple `(sourceCollection, docId, ...scopeFields)`. No partial-key writes, no partial-key deletes. Cross-scope wipes are impossible by construction.

A pool with no `scopeKey` declared has scope `= {}` and behaves byte-identically to the current plugin.

## Pool Config

`KnowledgePoolConfig` gains one optional field:

```ts
{
  extensionFields: [
    { name: 'locale', type: 'text', required: true },
    { name: 'category', type: 'text' },
  ],
  scopeKey: ['locale'],
}
```

Validation at plugin init (alongside the existing `RESERVED_FIELDS` check in `src/collections/embeddings.ts`):

- Every name in `scopeKey` must reference an existing entry in `extensionFields`. Otherwise throw.
- Every scope-key extension field must be declared `required: true`. Otherwise throw. This guarantees Payload's own required-field validation enforces non-null at insert time, so the framework does not need to duplicate it.
- `scopeKey` must not contain any reserved field name (`sourceCollection`, `docId`, `chunkIndex`, `chunkText`, `embeddingVersion`).

If `scopeKey` is absent or `[]`, pool behavior is unchanged.

## Embeddings Collection Index

`src/collections/embeddings.ts` currently declares:

```ts
indexes: [{ fields: ['sourceCollection', 'docId'] }]
```

This becomes:

```ts
indexes: [{ fields: ['sourceCollection', 'docId', ...scopeKey] }]
```

For pools without `scopeKey`, the index is byte-identical to today. For pools with scope, the composite index covers the full identity tuple. Payload's normal migration system emits the DDL.

## Adapter Contract

`src/types.ts`:

```ts
export type StoreChunkData = {
  sourceCollection: string
  docId: string
  scope: Record<string, any>          // NEW
  chunkIndex: number
  chunkText: string
  embeddingVersion: string
  embedding: number[] | Float32Array
  extensionFields: Record<string, any>
}

export type DbAdapter = {
  // ...
  storeChunk: (payload, poolName, data: StoreChunkData) => Promise<void>

  deleteChunks: (
    payload, poolName,
    sourceCollection: string,
    docId: string,
    scope: Record<string, any>,        // NEW, required, may be {}
  ) => Promise<void>

  hasEmbeddingVersion: (
    payload, poolName,
    sourceCollection: string,
    docId: string,
    embeddingVersion: string,
    scope: Record<string, any>,        // NEW, required, may be {}
  ) => Promise<boolean>

  // search() unchanged. Callers can already filter on scope fields via `where`.
}
```

Two notes on `StoreChunkData`:

- `scope` and `extensionFields` deliberately overlap. `extensionFields.locale === scope.locale`. The vectorize task is responsible for synthesizing `scope` from each chunk's scope-key extension-field values before calling `storeChunk`; adapters consume both fields as given and do not re-derive scope from `extensionFields`. `extensionFields` keeps the scope keys queryable and admin-visible; `scope` gives the adapter explicit identity without it having to read `pool.scopeKey`.
- `scope` is required, possibly `{}`. Callers cannot omit it. An optional `scope?` invites silent forgetting; required-but-empty makes the "no scope" decision explicit at every callsite.

## toKnowledgePool Author Surface

No signature change. `toKnowledgePool` still returns `Array<{ chunk: string, ...extensionFieldValues }>`.

What changes is the author's responsibility: with `scopeKey: ['locale']` declared, every returned chunk must include `locale`. The framework derives `scope` from each chunk by picking the scope-key fields off the returned object.

```ts
toKnowledgePool: async (doc, payload) => {
  const result = []
  for (const locale of ['en', 'es', 'fr']) {
    const localized = await payload.findByID({ collection, id: doc.id, locale })
    result.push(
      { chunk: localized.title, locale },
      { chunk: localized.body,  locale },
    )
  }
  return result
}
```

There is no per-chunk scope-value validation in the framework. Payload's required-field check at `storeChunk` time catches missing or null values with a clear error. Type mismatches are caught the same way (e.g. `locale: 0` for a `text` field). The only framework-level scope validation is the pool-config check at plugin init described above.

## Vectorize Task Algorithm

`src/tasks/vectorize.ts` becomes:

```ts
async function runVectorizeTask({ adapter, dynamicConfig, job, payload, poolName }) {
  const { embeddingConfig } = dynamicConfig
  const collection = job.collection
  const sourceDoc = job.doc
  const collectionConfig = dynamicConfig.collections[collection]
  if (!collectionConfig) throw new Error(/* ... */)

  // 1. Read + generate (pure)
  const chunkData = await collectionConfig.toKnowledgePool(sourceDoc, payload)
  validateChunkData(chunkData, String(sourceDoc.id), collection)

  // 2. Embed (external API; failure here leaves DB untouched)
  const chunkTexts = chunkData.map(c => c.chunk)
  const vectors = await embeddingConfig.realTimeIngestionFn!(chunkTexts)

  // 3. Group by scope
  const scopeKey = dynamicConfig.scopeKey ?? []
  const groups = groupByScope(chunkData, vectors, scopeKey)

  // 4. Per-scope: delete-then-insert (the invariant)
  for (const { scope, items } of groups) {
    await adapter.deleteChunks(payload, poolName, collection, String(sourceDoc.id), scope)
    await Promise.all(items.map(({ chunk, vector, index, ext }) =>
      adapter.storeChunk(payload, poolName, {
        sourceCollection: collection,
        docId: String(sourceDoc.id),
        scope,
        chunkIndex: index,
        chunkText: chunk,
        embeddingVersion: embeddingConfig.version,
        embedding: vector,
        extensionFields: ext,
      })
    ))
  }
}
```

### Two Behavioral Changes

**Reorder.** Today the order is `delete → toKnowledgePool → validate → embed → store`. The wipe happens first. Any failure in `toKnowledgePool`, validation, or embedding leaves the doc with no embeddings until someone fixes the bug and re-triggers.

The new order is `toKnowledgePool → validate → embed → delete → store`. The destructive step happens only after we have valid embeddings ready to insert. This is a general safety win independent of scope: an embedding-provider rate-limit error no longer wipes the doc's existing embeddings. The window between delete and the end of the per-scope `Promise.all` still allows partial-failure gaps; closing that fully needs an adapter-level transaction across delete+store and is out of scope here.

**Group by scope.** Each unique scope value gets its own delete-then-insert cycle. Re-embedding the `en` slice never touches the `es` slice.

### `groupByScope` Helper

```ts
// `pick(obj, keys)` returns a new object containing only those keys (lodash-style).
// `stableStringify(obj)` sorts keys before stringifying so key order does not
// affect grouping. Inline 4-line helpers; no new dependency.

function groupByScope(chunkData, vectors, scopeKey) {
  if (scopeKey.length === 0) {
    // Fast path: single group, scope = {}, indices unchanged.
    // No scope/extension split needed because there are no scope keys to extract.
    return [{
      scope: {},
      items: chunkData.map(({ chunk, ...ext }, i) => ({
        chunk, ext, vector: vectors[i], index: i,
      })),
    }]
  }
  const map = new Map<string, { scope: Record<string, any>; items: Item[] }>()
  chunkData.forEach(({ chunk, ...rest }, i) => {
    const scope = pick(rest, scopeKey)
    const key = stableStringify(scope)
    if (!map.has(key)) map.set(key, { scope, items: [] })
    const group = map.get(key)!
    group.items.push({
      chunk,
      ext: rest,                  // includes scope-key fields, for queryability
      vector: vectors[i],
      index: group.items.length,
    })
  })
  return [...map.values()]
}
```

Two design points:

- **`chunkIndex` is per-scope, not global.** Two `en` chunks get indices `0, 1`; two `es` chunks also get `0, 1`. `chunkIndex` is meaningful within a chunk-set, and chunk-sets are per-scope. Re-embedding `en` with the same chunk count produces identical `chunkIndex` values to before, so no churn.
- **Stable scope serialization.** `stableStringify` sorts keys before stringifying so `{locale:'en',tenant:'a'}` and `{tenant:'a',locale:'en'}` group together. A small inline helper is fine; no new dependency needed.

## Bulk Embed Pipeline

`src/utils/deleteDocumentEmbeddings.ts` gains a `scope: Record<string, any>` argument (required, may be `{}`) and forwards it to `adapter.deleteChunks`.

`src/tasks/bulkEmbedAll.ts` applies the same group-by-scope reorder when persisting batch results: chunks coming back from a batch are grouped by scope, and each group runs delete-then-insert independently. The exact integration point depends on how the bulk-batch result handler is structured; the planning phase should map this in detail. The intent is identical to the per-doc path: every delete operates on the full identity tuple.

## pg Adapter Implementation

`adapters/pg/src/index.ts` `deleteChunks` currently builds:

```ts
where: { and: [
  { sourceCollection: { equals: sourceCollection } },
  { docId:            { equals: String(docId)    } },
]}
```

It gains additional clauses, one per scope key:

```ts
where: { and: [
  { sourceCollection: { equals: sourceCollection } },
  { docId:            { equals: String(docId)    } },
  ...Object.entries(scope).map(([k, v]) => ({ [k]: { equals: v } })),
]}
```

Same shape change for `hasEmbeddingVersion`. No new SQL machinery. The existing where-translation in `adapters/pg/src/search.ts` already handles arbitrary equality predicates on extension-field columns.

`storeChunk` reads `data.extensionFields` as today; the scope-key columns are populated through that path. The new `data.scope` field is for the adapter to use when building queries (it does not need to re-derive scope from `extensionFields`).

## Migration & Backward Compatibility

**Pools without `scopeKey`.** Behavior is byte-identical to today. The composite index has the same columns. Adapters receive `scope: {}` on every call. No DB migration. No code change for downstream users beyond the major version bump.

**Adapter contract is breaking, so this is a major version bump.** `deleteChunks` and `hasEmbeddingVersion` add a required parameter; `StoreChunkData` adds a required field. Every adapter (pg, mongo) must update. Downstream consumers writing custom adapters get a TypeScript error pointing them at exactly what changed.

**Pools opting in on a non-empty embeddings table.** This is the only non-trivial migration case. The user must:

1. Ensure the chosen scope-key extension field already exists and is `required: true` on the pool.
2. Backfill any existing embedding rows where that column is null. Plugin init will throw if the field is not `required`, and Payload will throw at insert time on null values, so this step must happen before the new config is deployed.
3. Add `scopeKey: ['locale']` to the pool config and deploy. Payload's normal migration system updates the composite index DDL.

The README documents this prerequisite. The plugin does not automate the backfill (it is domain-specific: what value should null-locale rows get?).

**No data shape changes.** Embeddings rows on disk look the same. The change is to the index columns and to which clauses appear in delete/version-check WHEREs.

## Testing

This section lists only what the change adds. Existing specs that already cover the surface (search where-clause filtering, basic vectorize task behavior on a no-scope pool, etc.) should be re-run to confirm no regression but do not need new tests written.

**Unit tests:**

- `groupByScope` helper: no scope (single `{}` group, indices unchanged), single-key scope, multi-key scope, stable key ordering, preserves chunk order within group, per-group `chunkIndex` numbering starts at 0.
- Plugin init: `scopeKey` referencing missing `extensionField` throws; non-`required` `extensionField` throws; reserved-field overlap throws; valid config does not throw.

**Integration tests** in `dev/specs/`:

- **Scope isolation (the bug fix):** pool with `scopeKey: ['locale']`, embed a doc once with `en` and `es` chunks, re-trigger vectorize on the doc with only `en` chunks regenerated, assert `es` chunks remain in the DB unchanged.
- **Reorder safety:** mock `realTimeIngestionFn` to throw on a doc that already has embeddings, assert the existing chunks are still present after the failure (no destructive delete happened).
- **Bulk embed scope-aware:** run a bulk embed against a multi-scope pool, assert each scope group is independently delete-and-replaced (no cross-scope wipe).
- **Hard-fail on missing scope value:** chunk returned without the declared scope field. Payload's required-field validation throws at `storeChunk`. Because of the reorder, no rows have been wiped at the point of failure.

**Adapter test parity:** the scope tests above run against both the pg and mongo adapters. A shared test helper in `dev/specs/` exports the scenarios so each adapter's test suite consumes the same matrix. This is required, not optional.

## README Updates

Two additions:

1. **"Scope-aware chunk identity" section** documenting the `scopeKey` pool config, the `(sourceCollection, docId, ...scopeFields)` identity model, when to use it (locale, draft/published, tenant, etc.), and the migration prerequisite for opt-in on existing data.
2. **"Scope gotchas" subsection** covering the silent-bucket trap:

   > Any defined value is a valid scope, including `''`, `0`, and `false` (subject to the declared field type). If your `toKnowledgePool` returns `{ chunk, locale: '' }` for some chunks and `{ chunk, locale: 'en' }` for others, those go into two independent chunk-sets. Re-embedding the `'en'` set will not wipe the `''` set. Make sure your `toKnowledgePool` populates every declared scope field with the value you actually mean.

## Out of Scope

- A public `vectorizeDocument(doc, {scope})` API that re-embeds only one slice. Possible future addition; not needed for v1.
- Adapter-level transactions across delete+store. The reorder closes most of the safety gap; closing the rest is a separate concern.
- Automated backfill tooling for pools opting into `scopeKey` on existing data. Domain-specific; documented as a manual step.
