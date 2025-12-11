# Toggly Cloudflare Worker

One-click deployable Cloudflare Worker that applies Toggly feature-flag gating at the edge. It proxies your docs site and removes or blocks pages for disabled features.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ops-ai/Toggly.CloudflareWorker&vars=TOGGLY_API_BASE_URL,TOGGLY_ENVIRONMENT,TOGGLY_APP_KEY,ORIGIN_BASE_URL)

## What it does

- Page gating: blocks or redirects requests whose paths are mapped to disabled feature flags.
- Content scrubbing: strips HTML elements marked with `data-feature="flag_key"` when the flag is off.
- Edge caching: caches flags and the feature manifest for low-latency checks.

## Quick start

1) **Clone** this repo and install deps:
```bash
npm install
```

2) **Set environment variables** (all regular vars; none are secrets)
- You can set them in `wrangler.toml`, via the Cloudflare dashboard, or in `.dev.vars` for local dev:
  - `TOGGLY_API_BASE_URL` (defaults to `https://client.toggly.io`)
  - `TOGGLY_ENVIRONMENT` (e.g., `Production`)
  - `TOGGLY_APP_KEY` (your app key)
  - `ORIGIN_BASE_URL` (your docs origin, e.g., `https://my-docs.pages.dev`)

Example `.dev.vars`:
```env
TOGGLY_API_BASE_URL=https://client.toggly.io
TOGGLY_ENVIRONMENT=Production
TOGGLY_APP_KEY=your_app_key
ORIGIN_BASE_URL=https://my-docs.pages.dev
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

> If the deploy wizard shows both “Secrets” and “Text” sections for the same names, fill only the **Text** fields and leave the “Secrets” fields empty. All four vars are plain text.

## How it works
- Looks up page → feature mappings from `toggly-page-features.json` served by your origin.
- Fetches flags from Toggly using `@ops-ai/toggly-client-core`.
- Blocks entire pages (404 or redirect) if their feature is off.
- Streams HTML through `HTMLRewriter` to remove elements with disabled `data-feature` flags.

## Customization
- Change the page-level behavior in `src/index.ts` (404 vs redirect URL).
- Extend `getRequestContext` in `src/index.ts` to include user/tenant info for targeting.
- Tweak cache TTLs in `src/flags.ts` and `src/manifest.ts`.
