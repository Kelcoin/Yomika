import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeInferenceRepository } from '../../src/repositories/nativeInferenceRepository';

afterEach(resetInvokeAdapterForTests);

describe('native inference bridge', () => {
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

  it('reads the hosted upscale catalog and refuses entries it cannot install', async () => {
    const entry = {
      id: 'realcugan-2x-conservative',
      label: 'Real-CUGAN 2x 保守版（推荐）',
      scale: 2,
      version: '2022.02.27',
      source: 'https://github.com/bilibili/ailab/tree/main/Real-CUGAN',
      // 引擎要照着它把页面边缘那些细条补到 20px 再裁回来。
      minInputEdge: 20,
      files: [{
        name: 'realcugan-2x-conservative.onnx',
        size: 5272599,
        sha256: 'a'.repeat(64),
        directUrl: null,
      }],
    };
    const adapter = vi.fn(async () => ({ ok: true, value: { tag: 'models-v1', models: [entry] } }));
    setInvokeAdapterForTests(adapter);

    await expect(new NativeInferenceRepository().listUpscaleCatalog()).resolves.toEqual({
      ok: true,
      value: { tag: 'models-v1', models: [entry] },
    });
    expect(adapter).toHaveBeenCalledWith('model_release_list_upscalers', {});

    // 上游直链（HuggingFace 那类）是清单支持的字段，虽然当前两项 CUGAN 都是本仓库
    // 自己发布、不需要它。
    setInvokeAdapterForTests(async () => ({
      ok: true,
      value: { tag: 'models-v1', models: [{ ...entry, files: [{ ...entry.files[0], directUrl: 'https://huggingface.co/o/r/resolve/main/m.onnx' }] }] },
    }));
    await expect(new NativeInferenceRepository().listUpscaleCatalog()).resolves.toMatchObject({ ok: true });

    // 哈希短一位、或者没有规模，装下去也跑不起来：宁可在桥上就被拒掉，
    // 也不要写进目录再报「模型不可用」。
    for (const broken of [
      { ...entry, scale: 0 },
      { ...entry, minInputEdge: 0 },
      { ...entry, files: [{ ...entry.files[0], sha256: 'a'.repeat(63) }] },
      { ...entry, files: [] },
    ]) {
      setInvokeAdapterForTests(async () => ({ ok: true, value: { tag: 'models-v1', models: [broken] } }));
      const result = await new NativeInferenceRepository().listUpscaleCatalog();
      expect(result.ok).toBe(false);
    }
  });
});
