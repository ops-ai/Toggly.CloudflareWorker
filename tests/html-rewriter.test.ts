import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFeatureGateTransformer,
  shouldStripFeatureElement,
  transformHtmlResponse,
} from '../src/html-rewriter';

class TestHtmlRewriter {
  selector?: string;
  handlers?: { element(element: Element): void };

  on(selector: string, handlers: { element(element: Element): void }): this {
    this.selector = selector;
    this.handlers = handlers;
    return this;
  }

  transform(response: Response): Response {
    return response;
  }
}

function makeElement(attrs: Record<string, string | null>) {
  return {
    getAttribute: vi.fn((name: string) => attrs[name] ?? null),
    remove: vi.fn(),
  } as unknown as Element;
}

describe('HTML feature gating', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('instructs disabled-feature elements to be removed and reports the evaluated gate', () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const seen: Array<[string, boolean]> = [];
    const transformer = createFeatureGateTransformer(
      { Enabled: true },
      (featureKey, enabled) => seen.push([featureKey, enabled]),
    ) as unknown as TestHtmlRewriter;
    const element = makeElement({ 'data-feature': 'Disabled' });

    expect(transformer.selector).toBe('[data-feature]');
    transformer.handlers!.element(element);

    expect(seen).toEqual([['Disabled', false]]);
    expect(element.remove).toHaveBeenCalledOnce();
  });

  it('keeps enabled elements and ignores missing feature attributes', () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const observer = vi.fn();
    const transformer = createFeatureGateTransformer(
      { Enabled: true },
      observer,
    ) as unknown as TestHtmlRewriter;
    const enabledElement = makeElement({ 'data-feature': 'Enabled' });
    const missingAttributeElement = makeElement({ 'data-feature': null });

    transformer.handlers!.element(enabledElement);
    transformer.handlers!.element(missingAttributeElement);

    expect(observer).toHaveBeenCalledExactlyOnceWith('Enabled', true);
    expect(enabledElement.remove).not.toHaveBeenCalled();
    expect(missingAttributeElement.remove).not.toHaveBeenCalled();
  });

  it('does not strip negated wrappers even when the flag is disabled', () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const seen: Array<[string, boolean]> = [];
    const transformer = createFeatureGateTransformer(
      { Premium: false },
      (featureKey, enabled) => seen.push([featureKey, enabled]),
    ) as unknown as TestHtmlRewriter;
    const element = makeElement({
      'data-feature': 'Premium',
      'data-toggly-negate': 'true',
    });

    transformer.handlers!.element(element);

    expect(seen).toEqual([['Premium', false]]);
    expect(element.remove).not.toHaveBeenCalled();
    expect(shouldStripFeatureElement({ Premium: false }, 'Premium', 'true')).toBe(false);
  });

  it('keeps rendering when the telemetry observer fails', () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const transformer = createFeatureGateTransformer({ Enabled: true }, () => {
      throw new Error('telemetry unavailable');
    }) as unknown as TestHtmlRewriter;
    const element = makeElement({ 'data-feature': 'Enabled' });

    expect(() => transformer.handlers!.element(element)).not.toThrow();
    expect(element.remove).not.toHaveBeenCalled();
  });

  it('preserves an empty response body without constructing a rewriter', () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const response = new Response(null, { status: 204 });

    expect(transformHtmlResponse(response, {})).toBe(response);
  });

  it('removes stale Content-Length when passing a transformed stream through the response', async () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const response = new Response('feature content', {
      headers: { 'Content-Length': '15', 'Content-Type': 'text/html' },
    });

    const transformed = transformHtmlResponse(response, { Enabled: true });

    expect(transformed.headers.get('Content-Length')).toBeNull();
    await expect(transformed.text()).resolves.toBe('feature content');
  });
});
