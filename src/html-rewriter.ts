/**
 * HTMLRewriter transformer for section-level feature gating
 *
 * Removes elements with data-feature attributes when the corresponding
 * feature flag is disabled. Elements marked `data-toggly-negate="true"` are
 * left intact for client-side hydration (negate is evaluated in the client
 * SDK, not at the edge).
 */

export type FeatureGateObserver = (featureKey: string, enabled: boolean) => void;

/**
 * Whether the edge rewriter should remove a `[data-feature]` element.
 * Negated wrappers always stay for client hydration.
 */
export function shouldStripFeatureElement(
  flags: Record<string, boolean>,
  featureKey: string | null,
  negateAttr: string | null,
): boolean {
  if (negateAttr === 'true') {
    return false;
  }
  return Boolean(featureKey && !flags[featureKey]);
}

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
      const negateAttr = element.getAttribute('data-toggly-negate');
      if (featureKey && onFeatureGate) {
        try {
          onFeatureGate(featureKey, !!flags[featureKey]);
        } catch {
          // Telemetry must never break HTML rewriting
        }
      }
      if (shouldStripFeatureElement(flags, featureKey, negateAttr)) {
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

  // Cloudflare HTMLRewriter transforms a Response, retaining its streaming body.
  const transformer = createFeatureGateTransformer(flags, onFeatureGate);
  const transformedResponse = transformer.transform(response);

  // Copy headers but remove Content-Length as it may change
  const headers = new Headers(transformedResponse.headers);
  headers.delete('Content-Length');

  return new Response(transformedResponse.body, {
    status: transformedResponse.status,
    statusText: transformedResponse.statusText,
    headers,
  });
}
