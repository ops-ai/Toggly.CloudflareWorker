import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFlags, isFeatureEnabled, type DefinitionCacheRecorder } from '../src/flags';
import type { Env } from '../src/types';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TOGGLY_API_BASE_URL: 'https://definitions.toggly.io',
    TOGGLY_ENVIRONMENT: 'Production',
    TOGGLY_APP_KEY: 'my-app',
    ORIGIN_BASE_URL: 'https://docs.example.com',
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeMemoryCache(): Cache {
  const store = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const key = typeof request === 'string' ? request : new Request(request).url;
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      const key = typeof request === 'string' ? request : new Request(request).url;
      store.set(key, response.clone());
    },
    async delete(): Promise<boolean> {
      return false;
    },
  } as Cache;
}

function makeRecorder(): DefinitionCacheRecorder & {
  hits: number;
  misses: number;
} {
  const state = { hits: 0, misses: 0 };
  return {
    get hits() {
      return state.hits;
    },
    get misses() {
      return state.misses;
    },
    recordDefinitionCacheHit() {
      state.hits += 1;
    },
    recordDefinitionCacheMiss() {
      state.misses += 1;
    },
  };
}

describe('getFlags', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches evaluated-signed from definitions.toggly.io with app key and environment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ defs: { FeatureA: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const flags = await getFlags(makeEnv(), {}, null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://definitions.toggly.io/evaluated-signed/my-app/Production',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(flags).toEqual({ FeatureA: true });
  });

  it('defaults the definitions host when TOGGLY_API_BASE_URL is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ FeatureA: false }));
    vi.stubGlobal('fetch', fetchMock);

    await getFlags(makeEnv({ TOGGLY_API_BASE_URL: '' }), {}, null);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://definitions.toggly.io/evaluated-signed/my-app/Production',
    );
  });

  it('strips a trailing slash from the definitions base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await getFlags(
      makeEnv({ TOGGLY_API_BASE_URL: 'https://definitions.toggly.io/' }),
      {},
      null,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://definitions.toggly.io/evaluated-signed/my-app/Production',
    );
  });

  it('URL-encodes app key and environment in the definitions path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await getFlags(
      makeEnv({ TOGGLY_APP_KEY: 'app/key', TOGGLY_ENVIRONMENT: 'Prod 1' }),
      {},
      null,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://definitions.toggly.io/evaluated-signed/app%2Fkey/Prod%201',
    );
  });

  it('counts Cache API serve as a definition cache hit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ defs: { FeatureA: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const cache = makeMemoryCache();
    const recorder = makeRecorder();

    await getFlags(makeEnv(), {}, cache, 30, recorder);
    expect(recorder.misses).toBe(1);
    expect(recorder.hits).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getFlags(makeEnv(), {}, cache, 30, recorder);
    expect(recorder.hits).toBe(1);
    expect(recorder.misses).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts successful network apply as a definition cache miss', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ FeatureB: false }));
    vi.stubGlobal('fetch', fetchMock);
    const recorder = makeRecorder();

    const flags = await getFlags(makeEnv(), {}, null, 30, recorder);
    expect(flags).toEqual({ FeatureB: false });
    expect(recorder.misses).toBe(1);
    expect(recorder.hits).toBe(0);
  });

  it('still returns fetched flags when cache.put rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ defs: { FeatureA: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const recorder = makeRecorder();
    const cache = {
      async match(): Promise<Response | undefined> {
        return undefined;
      },
      async put(): Promise<void> {
        throw new Error('cache unavailable');
      },
      async delete(): Promise<boolean> {
        return false;
      },
    } as Cache;

    await expect(getFlags(makeEnv(), {}, cache, 30, recorder)).resolves.toEqual({
      FeatureA: true,
    });
    expect(recorder.misses).toBe(1);
    expect(recorder.hits).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not count network errors (no last-good retention)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const recorder = makeRecorder();

    const flags = await getFlags(makeEnv(), {}, null, 30, recorder);
    expect(flags).toEqual({});
    expect(recorder.hits).toBe(0);
    expect(recorder.misses).toBe(0);
  });

  it('does not increment on isFeatureEnabled beyond the underlying refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ FeatureA: true })));
    vi.stubGlobal('fetch', fetchMock);
    const recorder = makeRecorder();

    await isFeatureEnabled('FeatureA', makeEnv(), {}, null, 30, recorder);
    await isFeatureEnabled('FeatureA', makeEnv(), {}, null, 30, recorder);

    // Each call is one refresh attempt (no Cache API) → two misses, not per-flag extras
    expect(recorder.misses).toBe(2);
    expect(recorder.hits).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isFeatureEnabled', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns false when the flag is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ Other: true })));

    await expect(isFeatureEnabled('FeatureA', makeEnv(), {}, null)).resolves.toBe(false);
  });
});
