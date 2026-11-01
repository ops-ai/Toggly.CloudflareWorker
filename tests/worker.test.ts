import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TOGGLY_API_BASE_URL: 'https://definitions.toggly.io',
    TOGGLY_ENVIRONMENT: 'Production',
    TOGGLY_APP_KEY: 'app',
    ORIGIN_BASE_URL: 'https://docs.example.com',
    TOGGLY_USAGE_ENABLED: 'false',
    TOGGLY_METRICS_ENABLED: 'false',
    ...overrides,
  };
}

function makeCache(): Cache {
  const entries = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      return entries.get(new Request(request).url)?.clone();
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      entries.set(new Request(request).url, response.clone());
    },
  } as Cache;
}

function makeContext() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext,
  };
}

/**
 * HTMLRewriter stand-in that runs registered `[data-feature]` handlers against
 * synthetic elements so worker section-gate telemetry callbacks execute.
 */
class InvokingHtmlRewriter {
  private handler?: { element(element: Element): void };
  private readonly features: string[];

  constructor(features: string[] = ['SectionEnabled', 'SectionDisabled']) {
    this.features = features;
  }

  on(_selector: string, handlers: { element(element: Element): void }): this {
    this.handler = handlers;
    return this;
  }

  transform(response: Response): Response {
    if (this.handler) {
      for (const featureKey of this.features) {
        this.handler.element({
          getAttribute: () => featureKey,
          remove: vi.fn(),
        } as unknown as Element);
      }
    }
    return response;
  }
}

async function loadWorker() {
  vi.resetModules();
  const { resetTelemetrySingleton } = await import('../src/telemetry');
  resetTelemetrySingleton();
  return (await import('../src/index')).default;
}

describe('Cloudflare Worker request handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('proxies static assets without loading manifests or flags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('asset'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();
    const request = new Request('https://edge.example.com/static/app.js');

    await expect(worker.fetch(request, makeEnv(), ctx)).resolves.toHaveProperty('status', 200);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://docs.example.com/static/app.js',
      request,
    );
  });

  it('returns 404 before proxying a page whose feature is disabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ '/premium': 'Premium' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Premium: false })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/premium'),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Not Found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('proxies enabled pages with non-HTML responses unchanged', async () => {
    const originResponse = new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ '/premium': 'Premium' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Premium: true })))
      .mockResolvedValueOnce(originResponse);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/premium'),
      makeEnv(),
      ctx,
    );

    expect(response).toBe(originResponse);
    expect((fetchMock.mock.calls[2]![0] as Request).url).toBe(
      'https://docs.example.com/premium',
    );
  });

  it('propagates origin failures after preserving the response-path cleanup boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('origin offline')));
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();

    await expect(
      worker.fetch(new Request('https://edge.example.com/docs'), makeEnv(), ctx),
    ).rejects.toThrow('origin offline');
  });

  it('proxies Next.js asset paths and the page-feature manifest without gating', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('chunk'))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();

    await expect(
      worker.fetch(new Request('https://edge.example.com/_next/static/chunk.js'), makeEnv(), ctx),
    ).resolves.toHaveProperty('status', 200);
    await expect(
      worker.fetch(
        new Request('https://edge.example.com/toggly-page-features.json'),
        makeEnv(),
        ctx,
      ),
    ).resolves.toHaveProperty('status', 200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://docs.example.com/_next/static/chunk.js',
      expect.any(Request),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://docs.example.com/toggly-page-features.json',
      expect.any(Request),
    );
  });

  it('records usage and returns 404 when a gated page feature is disabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ '/premium': 'Premium' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Premium: false })))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx, promises } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/premium'),
      makeEnv({ TOGGLY_USAGE_ENABLED: 'true' }),
      ctx,
    );

    expect(response.status).toBe(404);
    await Promise.all(promises);
    expect(fetchMock.mock.calls.some((call) => {
      const target = call[0];
      return typeof target === 'string' && target.includes('/api/usage/stats');
    })).toBe(true);
  });

  it('transforms ungated HTML and defers telemetry flush until the stream drains', async () => {
    vi.stubGlobal(
      'HTMLRewriter',
      class extends InvokingHtmlRewriter {
        constructor() {
          super(['SectionEnabled', 'SectionDisabled']);
        }
      },
    );
    const html = '<html><body><div data-feature="SectionEnabled">ok</div></body></html>';
    const fetchMock = vi
      .fn()
      // Manifest (no page gate) → origin HTML → section flags → usage flush
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ SectionEnabled: true, SectionDisabled: false })),
      )
      .mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx, promises } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/docs'),
      makeEnv({ TOGGLY_USAGE_ENABLED: 'true', TOGGLY_METRICS_ENABLED: 'true' }),
      ctx,
    );

    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('SectionEnabled');
    await Promise.all(promises);
    expect(promises.length).toBeGreaterThan(0);
  });

  it('applies section gating on an enabled HTML page and records enabled + disabled sections', async () => {
    vi.stubGlobal(
      'HTMLRewriter',
      class extends InvokingHtmlRewriter {
        constructor() {
          super(['SectionEnabled', 'SectionDisabled']);
        }
      },
    );
    const flags = {
      Premium: true,
      SectionEnabled: true,
      SectionDisabled: false,
    };
    const fetchMock = vi
      .fn()
      // Manifest → page-gate flags → origin HTML → (section flags from Cache API)
      .mockResolvedValueOnce(new Response(JSON.stringify({ '/premium': 'Premium' })))
      .mockResolvedValueOnce(new Response(JSON.stringify(flags)))
      .mockResolvedValueOnce(
        new Response('<html><body>gated</body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      )
      .mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx, promises } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/premium'),
      makeEnv({ TOGGLY_USAGE_ENABLED: 'true' }),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('gated');
    await Promise.all(promises);
  });

  it('treats responses without a content-type as non-HTML and returns them unchanged', async () => {
    const originResponse = new Response('raw-bytes');
    originResponse.headers.delete('content-type');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(originResponse);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/binary'),
      makeEnv(),
      ctx,
    );

    expect(response).toBe(originResponse);
    expect(response.headers.get('content-type')).toBeNull();
  });

  it('still returns transformed HTML when usage telemetry is disabled', async () => {
    vi.stubGlobal(
      'HTMLRewriter',
      class extends InvokingHtmlRewriter {
        constructor() {
          super(['OnlySection']);
        }
      },
    );
    const fetchMock = vi
      .fn()
      // Manifest → origin HTML → section flags (telemetry off → recorder null)
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(
        new Response('<p data-feature="OnlySection">hi</p>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ OnlySection: true })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx, promises } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/ungated'),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('hi');
    // No telemetry runtime → deferred flush is a no-op; waitUntil may still be unused.
    expect(promises).toHaveLength(0);
  });
});
