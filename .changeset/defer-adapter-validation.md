---
"@payloadcms-vectorize/mongodb": patch
"@payloadcms-vectorize/cf": patch
---

Defer adapter config validation to call-time instead of throwing at construction.

The mongodb and cf adapter factories previously threw on missing config (e.g. `uri`, `dbName`, `binding`) the moment they were called, which happens while the Payload config is being built. That broke `payload generate:types` and `generate:importmap` in environments without runtime variables — such as CI that builds `payload-types` to publish as a separate package. Validation now runs when an adapter method is actually invoked, so config-time codegen no longer requires runtime credentials. Valid configurations behave exactly as before.

Closes #64.
