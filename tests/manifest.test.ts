import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

function makeEnv(): Env {
  return {
    TOGGLY_API_BASE_URL: 'https://definitions.toggly.io',
    TOGGLY_ENVIRONMENT: 'Production',
    TOGGLY_APP_KEY: 'app',
    ORIGIN_BASE_URL: 'https://docs.example.com',
  };
}

function makeCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    cache: {
      async match(request: RequestInfo | URL): Promise<Response | undefined> {
        const key = new Request(request).url;
        return entries.get(key)?.clone();
      },
      async put(request: RequestInfo | URL, response: Response): Promise<void> {
        entries.set(new Request(request).url, response.clone());
      },
    } as Cache,
  };
}

async function loadManifestModule() {
  vi.resetModules();
  return import('../src/manifest');
}

describe('page-feature manifest caching', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches the origin manifest and reuses it from memory within its TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ '/premium': 'Premium' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getManifest } = await loadManifestModule();

    await expect(getManifest(makeEnv(), null, 60_000)).resolves.toEqual({
      '/premium': 'Premium',
    });
    await expect(getManifest(makeEnv(), null, 60_000)).resolves.toEqual({
      '/premium': 'Premium',
    });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://docs.example.com/toggly-page-features.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses a Cloudflare Cache API manifest before fetching the origin', async () => {
    const { cache, entries } = makeCache();
    entries.set(
      'https://docs.example.com/toggly-page-features.json',
      new Response(JSON.stringify({ '/cached': 'Cached' })),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getManifest } = await loadManifestModule();

    await expect(getManifest(makeEnv(), cache)).resolves.toEqual({ '/cached': 'Cached' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches a fetched manifest and resolves exact and normalized paths', async () => {
    const { cache } = makeCache();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ '/exact': 'Exact', '/with-slash/': 'Slash' })),
      ),
    );
    const { getFeatureKeyForPath } = await loadManifestModule();

    await expect(getFeatureKeyForPath('/exact', makeEnv(), cache)).resolves.toBe('Exact');
    await expect(getFeatureKeyForPath('/with-slash', makeEnv(), cache)).resolves.toBe('Slash');
    await expect(getFeatureKeyForPath('/with-slash/', makeEnv(), cache)).resolves.toBe('Slash');
    await expect(getFeatureKeyForPath('/missing', makeEnv(), cache)).resolves.toBeNull();
  });

  it('returns an empty manifest after an unsuccessful origin response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    const { getManifest } = await loadManifestModule();

    await expect(getManifest(makeEnv(), null)).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith('Failed to fetch manifest: 503 ');
  });
});
