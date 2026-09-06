# Toggly Cloudflare Worker

One-click deployable Cloudflare Worker that applies Toggly feature-flag gating at the edge. It proxies your docs site and removes or blocks pages for disabled features.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ops-ai/Toggly.CloudflareWorker&vars=TOGGLY_API_BASE_URL,TOGGLY_ENVIRONMENT,TOGGLY_APP_KEY,ORIGIN_BASE_URL,TOGGLY_METRICS_BASE_URL)

## What it does

- Page gating: blocks or redirects requests whose paths are mapped to disabled feature flags.
- Content scrubbing: strips HTML elements marked with `data-feature="flag_key"` when the flag is off.
- Edge caching: caches flags and the feature manifest for low-latency checks.
- Usage + metrics: batches feature check/view (and optional measure/counter/observe) telemetry and posts gateway-accepted HTTPS JSON to `api/usage/stats` and `api/metrics` (Workers cannot use native gRPC). Flushes via `ctx.waitUntil` so responses stay fast; network errors soft-fail and never break flag evaluation.

## Quick start

1) **Clone** this repo and install deps:
```bash
npm install
```

2) **Set environment variables** (all regular vars; none are secrets)
- You can set them in `wrangler.toml`, via the Cloudflare dashboard, or in `.dev.vars` for local dev:
  - `TOGGLY_API_BASE_URL` (defaults to `https://definitions.toggly.io`) — flag definitions host. The worker GETs `{base}/evaluated-signed/{appKey}/{environment}`.
  - `TOGGLY_ENVIRONMENT` (e.g., `Production`) — included in the definitions path
  - `TOGGLY_APP_KEY` (your app key)
  - `ORIGIN_BASE_URL` (your docs origin, e.g., `https://my-docs.pages.dev`)
  - `TOGGLY_METRICS_BASE_URL` (defaults to `https://app.toggly.io/`) — usage/metrics gateway (separate from definitions)
  - `TOGGLY_USAGE_ENABLED` / `TOGGLY_METRICS_ENABLED` (optional; default enabled when `TOGGLY_APP_KEY` is set — set `false` to opt out)

Example `.dev.vars`:
```env
TOGGLY_API_BASE_URL=https://definitions.toggly.io
TOGGLY_ENVIRONMENT=Production
TOGGLY_APP_KEY=your_app_key
ORIGIN_BASE_URL=https://my-docs.pages.dev
TOGGLY_METRICS_BASE_URL=https://app.toggly.io/
```

3) **Run locally**
```bash
npm run dev
```
Visit `http://localhost:8787/docs/...`; the worker proxies to `ORIGIN_BASE_URL` and gates pages/sections.

4) **Deploy**
```bash
npm run deploy
```
Then attach a route or custom domain in the Cloudflare dashboard (e.g., `docs.example.com/*`).

> If the deploy wizard shows both “Secrets” and “Text” sections for the same names, fill only the **Text** fields and leave the “Secrets” fields empty. All vars are plain text.

## Telemetry

When usage tracking is enabled, page and section gating records **check** (and **view** when enabled) into an in-memory batch. Business metrics APIs (`measure` / `incrementCounter` / `observe`) are available on the isolate-scoped runtime for callers that extend the worker.

- Transport: `POST` JSON to `{TOGGLY_METRICS_BASE_URL}api/usage/stats` and `.../api/metrics`
- User-Agent: `toggly-cloudflare-worker/{version}`
- Wire fields: `variantStats` / `variantValues`; identity hashes are UTF-8 FNV-1a signed int32; HTTPS times are ISO-8601
- Caps: unique hashes per feature / app (10k), max features (500), metric keys (500), observations (1000)
- Flush: `ctx.waitUntil` after each request; for HTML, drain a teed rewriter stream first so section gates record, then flush (single-flight; restore batch on soft-fail)

## How it works
- Looks up page → feature mappings from `toggly-page-features.json` served by your origin.
- Fetches evaluated flags from `GET {TOGGLY_API_BASE_URL}/evaluated-signed/{appKey}/{environment}` (default host `https://definitions.toggly.io`). Accepts a bare flag map or `{ defs: … }`. Fetch failures soft-fail to `{}` so gating stays closed rather than taking the site down.
- Blocks entire pages (404 or redirect) if their feature is off.
- Streams HTML through `HTMLRewriter` to remove elements with disabled `data-feature` flags.
- Posts usage/metrics to `{TOGGLY_METRICS_BASE_URL}api/usage/stats` and `…/api/metrics` (default `https://app.toggly.io/`), not to the definitions host.
- Schedules telemetry flush with Cloudflare `waitUntil` so the client response is not blocked.

## Customization
- Change the page-level behavior in `src/index.ts` (404 vs redirect URL).
- Extend `getRequestContext` in `src/index.ts` to include `userId` (or other identity) for unique usage hashing.
- Tweak cache TTLs in `src/flags.ts` and `src/manifest.ts`.

## Verify
```bash
npm test
npm run build
```
