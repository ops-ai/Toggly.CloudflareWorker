/**
 * HTMLRewriter transformer for section-level feature gating
 *
 * Removes elements with data-feature attributes when the corresponding
 * feature flag is disabled.
 */

export type FeatureGateObserver = (featureKey: string, enabled: boolean) => void;

/**
 * Create an HTMLRewriter transformer that removes elements
 * based on feature flags
 */
export function createFeatureGateTransformer(
  flags: Record<string, boolean>,
  onFeatureGate?: FeatureGateObserver
) {
  const rewriter = new HTMLRewriter();
  return rewriter.on('[data-feature]', {
    element(element: Element) {
      const featureKey = element.getAttribute('data-feature');
      if (!featureKey) {
        return;
      }
      const enabled = !!flags[featureKey];
      if (onFeatureGate) {
        try {
          onFeatureGate(featureKey, enabled);
        } catch {
          // Telemetry must never break HTML rewriting
        }
      }
      if (!enabled) {
        element.remove();
      }
    },
  });
}

/**
 * Transform HTML response by removing disabled feature sections
 * Uses streaming for better performance
 */
export function transformHtmlResponse(
  response: Response,
  flags: Record<string, boolean>,
  onFeatureGate?: FeatureGateObserver
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }

  // Create transformer and transform the stream
  const transformer = createFeatureGateTransformer(flags, onFeatureGate);
  // @ts-expect-error - HTMLRewriter types may be incorrect in @cloudflare/workers-types
  const transformedStream = transformer.transform(body);

  // Copy headers but remove Content-Length as it may change
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');

  // Create new response with transformed stream
  // transformedStream is a ReadableStream from HTMLRewriter.transform()
  // @ts-expect-error - TypeScript types for HTMLRewriter may be incorrect
  return new Response(transformedStream as ReadableStream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
