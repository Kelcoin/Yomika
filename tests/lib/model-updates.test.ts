import { describe, expect, it } from 'vitest';

import { availableModelUpdates, modelUpdateFingerprint } from '../../src/lib/modelUpdates';
import type { InstalledModel, UpscaleCatalogModel } from '../../src/repositories/nativeInferenceRepository';

function installed(model: Pick<InstalledModel, 'id' | 'version'> & Partial<InstalledModel>): InstalledModel {
  return { scale: 2, kind: 'upscale', components: [], ...model };
}

function catalog(model: Pick<UpscaleCatalogModel, 'id' | 'version'> & Partial<UpscaleCatalogModel>): UpscaleCatalogModel {
  return {
    label: model.id,
    scale: 2,
    files: [{ name: `${model.id}.onnx`, size: 1, sha256: 'a'.repeat(64) }],
    ...model,
  };
}

describe('available model updates', () => {
  it('reports a hosted model whose catalog version moved on', () => {
    const updates = availableModelUpdates(
      [installed({ id: 'realcugan-2x-denoise3x', version: '2022.02.27' })],
      [catalog({ id: 'realcugan-2x-denoise3x', label: 'Real-CUGAN 2x 漫画（强降噪）', version: '2024.01.01' })],
    );
    expect(updates).toEqual([{
      id: 'realcugan-2x-denoise3x',
      label: 'Real-CUGAN 2x 漫画（强降噪）',
      installedVersion: '2022.02.27',
      availableVersion: '2024.01.01',
    }]);
  });

  it('leaves a model alone when the catalog carries the version already installed', () => {
    expect(availableModelUpdates(
      [installed({ id: 'realcugan-2x-denoise3x', version: '2024.01.01' })],
      [catalog({ id: 'realcugan-2x-denoise3x', version: '2024.01.01' })],
    )).toEqual([]);
  });

  it('keeps the newest installed copy when several versions are on disk', () => {
    // 后端按版本倒序给记录，同一个 id 只留第一条：比较的是「最新的已装版本」。
    expect(availableModelUpdates(
      [
        installed({ id: 'realcugan-2x-denoise3x', version: '2024.01.01' }),
        installed({ id: 'realcugan-2x-denoise3x', version: '2022.02.27' }),
      ],
      [catalog({ id: 'realcugan-2x-denoise3x', version: '2024.01.01' })],
    )).toEqual([]);
  });

  it('ignores what the catalog cannot update: built-ins, records without a scale', () => {
    expect(availableModelUpdates(
      [
        // 内置的 Anime4K 不在托管目录里，没有可参照的目标版本。
        installed({ id: 'anime4k-hq', version: '2' }),
        // 目录里有、但盘上这份没有 manifest：跑不起来，也不该提示更新。
        installed({ id: 'real-esrgan-x4', version: '1', scale: null }),
      ],
      [
        catalog({ id: 'real-esrgan-x4', version: '9' }),
      ],
    )).toEqual([]);
  });

  it('reports nothing when either side is missing', () => {
    expect(availableModelUpdates(undefined, [catalog({ id: 'a', version: '2' })])).toEqual([]);
    expect(availableModelUpdates([installed({ id: 'a', version: '1' })], undefined)).toEqual([]);
    expect(availableModelUpdates([], [])).toEqual([]);
  });
});

describe('model update fingerprint', () => {
  const update = (id: string, availableVersion: string) => ({ id, label: id, installedVersion: '1', availableVersion });

  it('is stable across the order the models came back in', () => {
    expect(modelUpdateFingerprint([update('b', '2'), update('a', '3')]))
      .toBe(modelUpdateFingerprint([update('a', '3'), update('b', '2')]));
  });

  it('changes when one more model can be updated, so a new release asks again', () => {
    expect(modelUpdateFingerprint([update('a', '3')])).toBe('a@3');
    expect(modelUpdateFingerprint([update('a', '3'), update('b', '2')])).toBe('a@3,b@2');
    // 同一个模型报了新版本，指纹也跟着变。
    expect(modelUpdateFingerprint([update('a', '4')])).toBe('a@4');
  });
});
