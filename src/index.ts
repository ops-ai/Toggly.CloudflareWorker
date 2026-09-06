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
import { getFlags, isFeatureEnabled } from './flags';
import { transformHtmlResponse } from './html-rewriter';
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

/**
 * Handle page-level gating
 * Returns a response (404 or redirect) if the page feature is disabled
 */
async function handlePageLevelGate(
  _path: string,
  featureKey: string,
  env: Env,
  context: RequestContext,
  cache: Cache | null,
  config: WorkerConfig,
  telemetry: TelemetryRuntime | null
): Promise<Response | null> {
  const isEnabled = await isFeatureEnabled(
    featureKey,
    env,
    context,
    cache,
    config.flagsCacheTTL
  );

  if (telemetry?.isUsageEnabled()) {
    telemetry.recordCheck(featureKey, isEnabled, identityFromContext(context), true);
    if (isEnabled) {
      telemetry.recordView(featureKey, identityFromContext(context));
    }
  }

  if (!isEnabled) {
    if (config.pageGateBehavior === PageGateBehavior.REDIRECT) {
      const redirectUrl = config.redirectUrl || '/upgrade';
      return Response.redirect(new URL(redirectUrl, env.ORIGIN_BASE_URL).toString(), 302);
    }
    return new Response('Not Found', {
      status: 404,
      statusText: 'Not Found',
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  return null; // Feature is enabled, continue processing
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
 * Return a teed HTML body and flush telemetry only after the rewriter stream
 * has been fully drained (section `data-feature` handlers run while pulling).
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

  const [clientBody, drainBody] = body.tee();
  ctx.waitUntil(
    (async () => {
      try {
        await drainBody.pipeTo(
          new WritableStream({
            write() {
              /* discard — drives HTMLRewriter so section telemetry records */
            },
          })
        );
      } catch {
        // Client abort / stream errors must not break soft-fail flush
      }
      try {
        await telemetry.flush();
      } catch {
        // soft-fail
      }
    })()
  );

  return new Response(clientBody, {
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

    try {
      // Skip processing for manifest and other static assets
      if (
        path === '/toggly-page-features.json' ||
        path.startsWith('/_next/') ||
        path.startsWith('/static/')
      ) {
        // Proxy to origin without modification
        const originUrl = new URL(path, env.ORIGIN_BASE_URL);
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

      if (featureKey) {
        const gateResponse = await handlePageLevelGate(
          path,
          featureKey,
          env,
          context,
          cache,
          WORKER_CONFIG,
          telemetry
        );

        if (gateResponse) {
          flushTelemetry(telemetry, ctx);
          return gateResponse;
        }
      }

      // Fetch from origin
      const originUrl = new URL(path, env.ORIGIN_BASE_URL);
      const originRequest = new Request(originUrl.toString(), request);

      const response = await fetch(originRequest);

      // If not HTML, return as-is
      if (!isHtmlResponse(response)) {
        flushTelemetry(telemetry, ctx);
        return response;
      }

      // For HTML responses, apply section-level gating
      const flags = await getFlags(env, context, cache, WORKER_CONFIG.flagsCacheTTL);
      const identity = identityFromContext(context);
      const transformedResponse = transformHtmlResponse(
        response,
        flags,
        (sectionFeature, enabled) => {
          if (!telemetry?.isUsageEnabled()) return;
          telemetry.recordCheck(sectionFeature, enabled, identity, true);
          if (enabled) {
            telemetry.recordView(sectionFeature, identity);
          }
        }
      );

      return respondHtmlWithDeferredFlush(transformedResponse, telemetry, ctx);
    } catch (err) {
      flushTelemetry(telemetry, ctx);
      throw err;
    }
  },
};
