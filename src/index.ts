/**
 * Cloudflare Worker for Toggly
 *
 * This worker enforces feature flag gating at the edge, ensuring that
 * documentation for disabled features is not accessible.
 *
 * Features:
 * - Page-level gating: Returns 404 or redirects when page feature is disabled
 * - Section-level gating: Removes elements with data-feature attributes
 * - Edge-side caching for flags and manifest
 * - Batched usage + business metrics via HTTPS JSON (gateway path)
 */

import type { Env, RequestContext, WorkerConfig } from './types';
import { PageGateBehavior } from './types';
import { getFeatureKeyForPath } from './manifest';
import { getFlags } from './flags';
import { transformHtmlResponse } from './html-rewriter';
import { RequestScopedUsageRecorder } from './request-usage';
import { wrapReadableWithCompletion } from './stream-flush';
import {
  getOrCreateTelemetry,
  parseBoolEnv,
  resolveMetricsBaseUrl,
  type TelemetryRuntime,
} from './telemetry';

// Worker configuration
const WORKER_CONFIG: WorkerConfig = {
  pageGateBehavior: PageGateBehavior.RETURN_404,
  redirectUrl: '/upgrade', // Only used if pageGateBehavior is REDIRECT
  flagsCacheTTL: 30, // seconds
  manifestCacheTTL: 300, // seconds
};

function createTelemetry(env: Env): TelemetryRuntime | null {
  const hasAppKey = Boolean(env.TOGGLY_APP_KEY);
  return getOrCreateTelemetry({
    appKey: env.TOGGLY_APP_KEY,
    environment: env.TOGGLY_ENVIRONMENT,
    metricsBaseUrl: resolveMetricsBaseUrl(env.TOGGLY_METRICS_BASE_URL),
    enableUsageTracking: parseBoolEnv(env.TOGGLY_USAGE_ENABLED, hasAppKey),
    enableMetrics: parseBoolEnv(env.TOGGLY_METRICS_ENABLED, hasAppKey),
  });
}

function identityFromContext(context: RequestContext): string | undefined {
  if (typeof context.userId === 'string' && context.userId.length > 0) {
    return context.userId;
  }
  return undefined;
}

/**
 * Extract request context from request (cookies, headers, etc.)
 * Currently returns empty object, but can be extended to extract
 * user/tenant IDs from cookies or headers
 */
function getRequestContext(_request: Request): RequestContext {
  // TODO: Extract user/tenant information from cookies or headers
  // Example:
  // const cookieHeader = request.headers.get('Cookie');
  // const userId = extractUserIdFromCookie(cookieHeader);
  // return { userId, tenantId: extractTenantId(request) };

  return {};
}

/**
 * Check if response is HTML
 */
function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('text/html');
}

type PageGateResult = {
  /** Non-null when the page is blocked (404/redirect). */
  response: Response | null;
  /**
   * Flags from the single refresh for this request when the page gate ran.
   * Reused for section gating so we do not double-count definition cache hits.
   */
  flags: Record<string, boolean> | null;
};

/**
 * Handle page-level gating
 * Returns a response (404 or redirect) if the page feature is disabled
 */
async function handlePageLevelGate(
  featureKey: string,
  env: Env,
  context: RequestContext,
  cache: Cache | null,
  config: WorkerConfig,
  usage: RequestScopedUsageRecorder,
  telemetry: TelemetryRuntime | null
): Promise<PageGateResult> {
  const recorder = telemetry?.isUsageEnabled() ? telemetry : null;
  const flags = await getFlags(
    env,
    context,
    cache,
    config.flagsCacheTTL,
    recorder
  );
  const isEnabled = flags[featureKey] ?? false;

  usage.recordGate(featureKey, isEnabled, identityFromContext(context));

  if (!isEnabled) {
    if (config.pageGateBehavior === PageGateBehavior.REDIRECT) {
      const redirectUrl = config.redirectUrl || '/upgrade';
      return {
        response: Response.redirect(new URL(redirectUrl, env.ORIGIN_BASE_URL).toString(), 302),
        flags: null,
      };
    }
    return {
      response: new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
        headers: {
          'Content-Type': 'text/plain',
        },
      }),
      flags: null,
    };
  }

  return { response: null, flags };
}

function flushTelemetry(
  telemetry: TelemetryRuntime | null,
  ctx: ExecutionContext
): void {
  if (!telemetry) return;
  try {
    telemetry.scheduleFlush((promise) => ctx.waitUntil(promise));
  } catch {
    // never break the response path
  }
}

/**
 * Return HTML with telemetry flushed after the client-consumed stream
 * completes. Pull-driven wrapper preserves backpressure (no tee + eager drain).
 */
function respondHtmlWithDeferredFlush(
  response: Response,
  telemetry: TelemetryRuntime | null,
  ctx: ExecutionContext
): Response {
  const body = response.body;
  if (!body || !telemetry) {
    flushTelemetry(telemetry, ctx);
    return response;
  }

  const wrapped = wrapReadableWithCompletion(
    body,
    () => telemetry.flush(),
    (promise) => ctx.waitUntil(promise),
  );

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Cloudflare Worker entry point
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const telemetry = createTelemetry(env);
    const usage = new RequestScopedUsageRecorder(telemetry);

    try {
      // Skip processing for manifest and other static assets
      if (
        path === '/toggly-page-features.json' ||
        path.startsWith('/_next/') ||
        path.startsWith('/static/')
      ) {
        // Proxy to origin without modification
        const originUrl = new URL(path + url.search, env.ORIGIN_BASE_URL);
        return fetch(originUrl.toString(), request);
      }

      // Get request context (for future user/tenant targeting)
      const context = getRequestContext(request);

      // Get cache
      const cache = caches.default;

      // Check for page-level feature gate
      const featureKey = await getFeatureKeyForPath(
        path,
        env,
        cache,
        WORKER_CONFIG.manifestCacheTTL * 1000
      );
      let pageFlags: Record<string, boolean> | null = null;

      if (featureKey) {
        const gate = await handlePageLevelGate(
          featureKey,
          env,
          context,
          cache,
          WORKER_CONFIG,
          usage,
          telemetry
        );

        if (gate.response) {
          flushTelemetry(telemetry, ctx);
          return gate.response;
        }
        pageFlags = gate.flags;
      }

      // Fetch from origin (preserve query string)
      const originUrl = new URL(path + url.search, env.ORIGIN_BASE_URL);
      const originRequest = new Request(originUrl.toString(), request);

      const response = await fetch(originRequest);

      // If not HTML, return as-is
      if (!isHtmlResponse(response)) {
        flushTelemetry(telemetry, ctx);
        return response;
      }

      // For HTML responses, apply section-level gating. Reuse page-gate flags
      // when present so one request does not double-count definition cache hits.
      const recorder = telemetry?.isUsageEnabled() ? telemetry : null;
      const flags =
        pageFlags ??
        (await getFlags(
          env,
          context,
          cache,
          WORKER_CONFIG.flagsCacheTTL,
          recorder
        ));
      const identity = identityFromContext(context);
      const transformedResponse = transformHtmlResponse(
        response,
        flags,
        (sectionFeature, enabled) => {
          usage.recordGate(sectionFeature, enabled, identity);
        }
      );

      return respondHtmlWithDeferredFlush(transformedResponse, telemetry, ctx);
    } catch (err) {
      flushTelemetry(telemetry, ctx);
      throw err;
    }
  },
};
