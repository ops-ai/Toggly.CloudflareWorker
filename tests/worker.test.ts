import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

class TestHtmlRewriter {
  on(): this {
    return this;
  }

  transform(body: ReadableStream): ReadableStream {
    return body;
  }
}

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

async function loadWorker() {
  vi.resetModules();
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

  it('streams HTML responses through the feature-gate transformer', async () => {
    vi.stubGlobal('HTMLRewriter', TestHtmlRewriter);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(
        new Response('<main>content</main>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({})));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', { default: makeCache() });
    const worker = await loadWorker();
    const { ctx } = makeContext();

    const response = await worker.fetch(
      new Request('https://edge.example.com/docs'),
      makeEnv(),
      ctx,
    );

    await expect(response.text()).resolves.toBe('<main>content</main>');
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
});
