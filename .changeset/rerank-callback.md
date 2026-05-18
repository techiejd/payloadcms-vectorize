---
"payloadcms-vectorize": minor
"@payloadcms-vectorize/pg": minor
"@payloadcms-vectorize/cf": minor
"@payloadcms-vectorize/mongodb": minor
---

Add optional `rerank` callback on `EmbeddingConfig` for per-pool reranking. When configured, the plugin fetches `Math.floor(limit * multiplier)` candidates from the adapter, hands them to the user-supplied callback (`(query, results) => Promise<results>`), and trims the callback's output back down to the caller's `limit`. Provider-agnostic — bring your own Voyage / Cohere / local cross-encoder. `multiplier` must be a finite number `>= 1`; invalid configs are rejected at plugin init. Callback errors propagate to the caller.
