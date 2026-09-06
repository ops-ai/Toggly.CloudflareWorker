import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFlags, isFeatureEnabled } from '../src/flags';
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
