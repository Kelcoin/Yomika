import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeInferenceRepository } from '../../src/repositories/nativeInferenceRepository';

afterEach(resetInvokeAdapterForTests);

describe('native inference bridge', () => {
  it('uses CPU fallback and validates rendition dimensions', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { rgba: [1, 2, 3, 4], width: 1, height: 1 } }));
    setInvokeAdapterForTests(adapter);
    const result = await new NativeInferenceRepository().cpuScale({ rgba: [1, 2, 3, 4], width: 1, height: 1, scale: 1, maxPixels: 1 });
    expect(result).toEqual({ ok: true, value: { rgba: [1, 2, 3, 4], width: 1, height: 1 } });
    expect(adapter).toHaveBeenCalledWith('inference_cpu_scale', { input: { rgba: [1, 2, 3, 4], width: 1, height: 1, scale: 1, maxPixels: 1 } });
  });

  it('starts, loads and cancels persistent jobs', async () => {
    const job = { id: 'job-a', status: 'queued', itemCount: 2, completedCount: 0 };
    const adapter = vi.fn(async () => ({ ok: true, value: job }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeInferenceRepository();
    await repository.start({ id: 'job-a', sourceScope: 'scope-a', sourceId: 'gallery-a', modelId: 'model-a', modelVersion: '1', inputHashes: ['a', 'b'] });
    await repository.getJob('job-a'); await repository.cancel('job-a');
    await repository.checkpoint({ jobId: 'job-a', itemIndex: 0, completedTile: 4, status: 'running' });
    await repository.pause('job-a'); await repository.resume('job-a');
    await repository.validateModel({ id: 'm', version: '1', format: 'onnx', scale: 2, maxPixels: 100, sha256: 'a'.repeat(64), supportedBackends: ['cpu'] }, [1, 2, 3]);
    await repository.installModel({ id: 'm', version: '1', format: 'onnx', scale: 2, maxPixels: 100, sha256: 'a'.repeat(64), supportedBackends: ['cpu'] }, [80, 75, 3, 4]);
    expect(adapter).toHaveBeenNthCalledWith(1, 'inference_start', { input: { id: 'job-a', sourceScope: 'scope-a', sourceId: 'gallery-a', modelId: 'model-a', modelVersion: '1', inputHashes: ['a', 'b'] } });
    expect(adapter).toHaveBeenNthCalledWith(2, 'inference_get_job', { id: 'job-a' });
    expect(adapter).toHaveBeenNthCalledWith(3, 'inference_cancel', { id: 'job-a' });
    expect(adapter).toHaveBeenNthCalledWith(4, 'inference_checkpoint', { input: { jobId: 'job-a', itemIndex: 0, completedTile: 4, status: 'running' } });
    expect(adapter).toHaveBeenNthCalledWith(5, 'inference_pause', { id: 'job-a' });
    expect(adapter).toHaveBeenNthCalledWith(6, 'inference_resume', { id: 'job-a' });
    expect(adapter).toHaveBeenNthCalledWith(7, 'inference_validate_model', { input: { manifest: { id: 'm', version: '1', format: 'onnx', scale: 2, maxPixels: 100, sha256: 'a'.repeat(64), supportedBackends: ['cpu'] }, model: [1, 2, 3] } });
    expect(adapter).toHaveBeenNthCalledWith(8, 'inference_install_model', { input: { manifest: { id: 'm', version: '1', format: 'onnx', scale: 2, maxPixels: 100, sha256: 'a'.repeat(64), supportedBackends: ['cpu'] }, archive: [80, 75, 3, 4] } });
  });

  it('clears the native inference cache through a typed result', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { entriesCleared: 3 } }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeInferenceRepository().clearCache()).resolves.toEqual({
      ok: true,
      value: { entriesCleared: 3 },
    });
    expect(adapter).toHaveBeenCalledWith('inference_clear_cache', {});
  });
});
