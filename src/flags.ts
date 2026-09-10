/**
 * Feature flag fetching and caching utilities.
 *
 * Fetches evaluated flags from definitions.toggly.io
 * (`/evaluated-signed/{appKey}/{environment}`) and caches them with the
 * Cloudflare Cache API. Kept as a direct fetch (no `@ops-ai/toggly-client-core`)
 * so the Worker hits the definitions path, not the legacy client.toggly.io
 * `{appKey}-{environment}/defs` URL.
 */

import type { RequestContext, Env } from './types';

const DEFAULT_FLAGS_CACHE_TTL_SECONDS = 30;
const FLAGS_FETCH_TIMEOUT_MS = 5_000;

/** Default host for flag definitions (not the usage/metrics gateway). */
export const DEFAULT_DEFINITIONS_BASE_URL = 'https://definitions.toggly.io';

type Flags = Record<string, boolean>;

interface TogglyApiPayload {
  defs?: Flags;
  [key: string]: unknown;
}

/**
 * Optional recorder for definition-refresh cache hit/miss outcomes.
 * Injected from telemetry so this module stays free of hard telemetry cycles.
 */
export interface DefinitionCacheRecorder {
  recordDefinitionCacheHit(): void;
  recordDefinitionCacheMiss(): void;
}

/**
 * Build the definitions.toggly.io evaluated-signed URL.
 * Returns null when app key or environment is missing.
 */
export function buildEvaluatedSignedUrl(env: Env): string | null {
  const appKey = env.TOGGLY_APP_KEY?.trim();
  const environment = env.TOGGLY_ENVIRONMENT?.trim();
  if (!appKey || !environment) {
    return null;
  }

  const baseUrl = (env.TOGGLY_API_BASE_URL?.trim() || DEFAULT_DEFINITIONS_BASE_URL).replace(
    /\/$/,
    '',
  );
  return `${baseUrl}/evaluated-signed/${encodeURIComponent(appKey)}/${encodeURIComponent(environment)}`;
}

function unwrapDefsPayload(payload: TogglyApiPayload | Flags): Flags {
  const defs = (payload as TogglyApiPayload).defs;
  if (defs && typeof defs === 'object') {
    return defs;
  }
  return payload as Flags;
}

function getFlagsCacheKey(env: Env, context: RequestContext): string {
  const contextKey = JSON.stringify(context);
  return `flags:${encodeURIComponent(env.TOGGLY_APP_KEY)}:${encodeURIComponent(env.TOGGLY_ENVIRONMENT)}:${contextKey}`;
}

interface DefinitionsFetchResult {
  flags: Flags;
  /** True when the network returned a successful body to apply. */
  ok: boolean;
}

async function fetchFlagsFromDefinitions(env: Env): Promise<DefinitionsFetchResult> {
  const url = buildEvaluatedSignedUrl(env);
  if (!url) {
    return { flags: {}, ok: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLAGS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { flags: {}, ok: false };
    }
    const payload = (await response.json()) as TogglyApiPayload | Flags;
    return { flags: unwrapDefsPayload(payload), ok: true };
  } catch {
    return { flags: {}, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get feature flags for the given context.
 * Uses Cloudflare's cache API when available.
 *
 * Counts one definition-refresh outcome per call when a recorder is provided:
 * Cache API match → hit; successful network apply → miss.
 * Network errors without last-good retention are not counted (N/A per design).
 */
export async function getFlags(
  env: Env,
  context: RequestContext,
  cache: Cache | null,
  cacheTTLSeconds: number = DEFAULT_FLAGS_CACHE_TTL_SECONDS,
  recorder?: DefinitionCacheRecorder | null,
): Promise<Flags> {
  const cacheKey = getFlagsCacheKey(env, context);
  const cacheRequest = new Request(`https://toggly-cache/${cacheKey}`);

  if (cache) {
    const cachedResponse = await cache.match(cacheRequest);
    if (cachedResponse) {
      recorder?.recordDefinitionCacheHit();
      return (await cachedResponse.json()) as Flags;
    }
  }

  const { flags, ok } = await fetchFlagsFromDefinitions(env);

  if (ok) {
    // New revision applied from network (fills Cache API when available).
    recorder?.recordDefinitionCacheMiss();
  }

  if (cache) {
    // Put success body or empty failure body so subsequent requests can hit
    // Cache API (same behavior as before ok/fail classification).
    // Soft-fail writes: a rejected put must not fail the request after fetch.
    const response = new Response(JSON.stringify(flags), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${cacheTTLSeconds}`,
      },
    });
    try {
      await cache.put(cacheRequest, response);
    } catch {
      // Cache unavailable / quota / transient write errors — keep fetched flags.
    }
  }

  return flags;
}

/**
 * Check if a specific feature flag is enabled
 */
export async function isFeatureEnabled(
  flagKey: string,
  env: Env,
  context: RequestContext,
  cache: Cache | null,
  cacheTTLSeconds?: number,
  recorder?: DefinitionCacheRecorder | null,
): Promise<boolean> {
  const flags = await getFlags(env, context, cache, cacheTTLSeconds, recorder);
  return flags[flagKey] ?? false;
}
