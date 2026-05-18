---
"payloadcms-vectorize": patch
"@payloadcms-vectorize/pg": patch
"@payloadcms-vectorize/cf": patch
"@payloadcms-vectorize/mongodb": patch
---

Fix: reorder the vectorize task so existing chunks are deleted only after `toKnowledgePool` + embeddings succeed. Previously, a transient embedding-provider failure during re-vectorization would wipe a document's existing chunks before the new ones were ready, leaving the document temporarily unsearchable. Also documents a first-class Localization (i18n) pattern in the README.
