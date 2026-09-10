## 0.3.0

2026-09-09

### Added
- Report definition-refresh cache hits/misses on usage telemetry
  (`definitionCacheHits` / `definitionCacheMisses` on `POST api/usage/stats`).
- Cache API match without a network round-trip counts as a hit; successful
  network apply that fills the Cache API counts as a miss (one outcome per
  `getFlags` refresh attempt).

### Changed
- Package / Worker version `0.2.1` → `0.3.0` (User-Agent
  `toggly-cloudflare-worker/0.3.0`).

## 0.2.1

2026-09-06

### Fixed
- Fetch flag definitions from `https://definitions.toggly.io/evaluated-signed/{appKey}/{environment}` instead of the legacy `client.toggly.io` `{appKey}-{environment}/defs` path used by `@ops-ai/toggly-client-core@0.1.5`.
- Document definitions vs metrics hosts so README, Wrangler, and `.dev.vars` match the worker.

### Changed
- Drop the `@ops-ai/toggly-client-core` runtime dependency; the Worker fetches the definitions endpoint directly.

## 0.2.0

2026-09-06

### Added
- Batched feature usage and business metrics export over gateway-accepted HTTPS
  JSON (`api/usage/stats`, `api/metrics`) via `fetch` (Workers have no native
  gRPC). Soft-fails network errors so flag evaluation is never blocked.
- In-memory batchers with hard caps on unique identity hashes, feature count,
  metric keys, and observations; flush scheduled through `ctx.waitUntil`.
- Wire shape parity: `variantStats` / `variantValues`, UTF-8 FNV-1a signed int32
  identity hashes, ISO-8601 times on the HTTPS path.
- Env config: `TOGGLY_METRICS_BASE_URL` (default `https://app.toggly.io/`),
  `TOGGLY_USAGE_ENABLED`, `TOGGLY_METRICS_ENABLED`.
- User-Agent `toggly-cloudflare-worker/{VERSION}` on telemetry POSTs.
- Records check/view when page and section gating evaluates.

### Fixed
- Soft-fail restore union-merges enabled/disabled/used uniqueness hash sets
  (snapshot alongside wire counts), matching PHP/.NET behavior.
- Concurrent `flush()` during an in-flight drain schedules a follow-up pass so
  batches recorded mid-send are not stranded.
