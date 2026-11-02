import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestScopedUsageRecorder } from '../src/request-usage';
import { wrapReadableWithCompletion } from '../src/stream-flush';
import {
  getOrCreateTelemetry,
  resetTelemetrySingleton,
} from '../src/telemetry';

describe('RequestScopedUsageRecorder', () => {
  beforeEach(() => {
    resetTelemetrySingleton();
  });

  it('keeps checkCount for every gate while requestCount stays unique', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const runtime = getOrCreateTelemetry({
      appKey: 'app',
      environment: 'Production',
      metricsBaseUrl: 'https://app.toggly.io/',
      enableUsageTracking: true,
      enableMetrics: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })!;

    const usage = new RequestScopedUsageRecorder(runtime);
    expect(usage.recordGate('Feat', true)).toBe(true);
    expect(usage.recordGate('Feat', true)).toBe(false);
    expect(usage.recordGate('Feat', true)).toBe(false);
    expect(usage.recordGate('Other', true)).toBe(true);
    expect(usage.recordGate('Feat', false)).toBe(true);

    await runtime.flush();
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    ) as {
      stats: Array<{
        feature: string;
        variantStats: Record<string, { checkCount: number; requestCount: number }>;
      }>;
    };

    const byFeature = Object.fromEntries(body.stats.map((s) => [s.feature, s]));
    expect(byFeature.Feat!.variantStats.enabled!.checkCount).toBe(3);
    expect(byFeature.Feat!.variantStats.enabled!.requestCount).toBe(1);
    expect(byFeature.Feat!.variantStats.disabled!.checkCount).toBe(1);
    expect(byFeature.Feat!.variantStats.disabled!.requestCount).toBe(1);
    expect(byFeature.Other!.variantStats.enabled!.requestCount).toBe(1);
  });
});

describe('wrapReadableWithCompletion', () => {
  it('preserves chunk order and flushes only after consumer completes', async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    let readIndex = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readIndex >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[readIndex++]!);
      },
    });

    const onComplete = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    const wrapped = wrapReadableWithCompletion(upstream, onComplete, waitUntil);
    const reader = wrapped.getReader();

    expect(onComplete).not.toHaveBeenCalled();

    const received: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value![0]!);
      if (received.length < 3) {
        expect(onComplete).not.toHaveBeenCalled();
      }
    }

    expect(received).toEqual([1, 2, 3]);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('schedules completion when the consumer cancels early', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9]));
      },
    });

    const onComplete = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn((p: Promise<unknown>) => p);
    const wrapped = wrapReadableWithCompletion(upstream, onComplete, waitUntil);
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel('client-abort');

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('getOrCreateTelemetry config change', () => {
  beforeEach(() => {
    resetTelemetrySingleton();
  });

  it('flushes the previous isolate runtime when config key changes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const first = getOrCreateTelemetry({
      appKey: 'app-a',
      environment: 'Production',
      metricsBaseUrl: 'https://app.toggly.io/',
      enableUsageTracking: true,
      enableMetrics: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(first).not.toBeNull();
    first!.recordCheck('feat', true);

    const second = getOrCreateTelemetry({
      appKey: 'app-b',
      environment: 'Production',
      metricsBaseUrl: 'https://app.toggly.io/',
      enableUsageTracking: true,
      enableMetrics: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalled();
    });
    const usageCalls = fetchImpl.mock.calls.filter(
      (c) => typeof c[0] === 'string' && String(c[0]).includes('api/usage/stats'),
    );
    expect(usageCalls.length).toBeGreaterThanOrEqual(1);
  });
});
