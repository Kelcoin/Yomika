import { describe, expect, it } from 'vitest';

import { availableVariantUpdates, installedVariantId } from '../../src/lib/dlssnrUpdates';
import type { DlssnrCatalog, DlssnrStatus, DlssnrVariant } from '../../src/repositories/nativeDlssnrRepository';

// README 与清单里那三条真实哈希：两种变体**字节数完全相同**（165,840,496），只有哈希
// 分得开——所以下面这些用例里，凡是要区分 `official` 与 `community` 的地方都得靠它。
const OFFICIAL = 'e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e';
const COMMUNITY = '984bee0f775c277d5829b8fd6775d53a7b0f75396c852b3aaf06a18375f81014';
const SF_V2 = '6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927';
/** 一份谁都不认识的片段（社区两年后新发的那种）。 */
const STRANGER = 'a'.repeat(64);

function status(overrides: Partial<DlssnrStatus> = {}): DlssnrStatus {
  return {
    dllPresent: true,
    variant: 'official',
    variantLabel: 'NVIDIA 官方原版（RTX 50 系原生）',
    dllBytes: 165_840_496,
    dllVersion: '310.8.0.0',
    dllSha256: OFFICIAL,
    gpu: { name: 'NVIDIA GeForce RTX 5090 D', recommendedVariant: 'official' },
    gpuName: 'NVIDIA GeForce RTX 5090 D',
    recommendedVariant: 'official',
    recommendedLabel: 'NVIDIA 官方原版（RTX 50 系原生）',
    coreAvailable: true,
    installable: true,
    available: true,
    probe: null,
    probeValid: true,
    error: null,
    ...overrides,
  };
}

function variant(entry: Partial<DlssnrVariant> & Pick<DlssnrVariant, 'id'>): DlssnrVariant {
  return {
    label: entry.id,
    note: '',
    series: [],
    asset: `nvngx_dlssnr--${entry.id}.dll`,
    size: 165_840_496,
    sha256: '0'.repeat(64),
    ...entry,
  };
}

function catalog(variants: DlssnrVariant[]): DlssnrCatalog {
  return { tag: 'models-v1', license: null, variants };
}

/** 清单里那三条，和仓库正文里的 `dlssnr-manifest.json` 一样。 */
function published(): DlssnrCatalog {
  return catalog([
    variant({ id: 'official', label: 'NVIDIA 官方原版（RTX 50 系原生）', series: [50], size: 165_840_496, sha256: OFFICIAL }),
    variant({ id: 'community', label: 'Lecram 版', series: [40, 50], size: 165_840_496, sha256: COMMUNITY }),
    variant({ id: 'sf-v2', label: 'SF 版', series: [20, 30, 40, 50], size: 165_830_144, sha256: SF_V2 }),
  ]);
}

describe('which snippet is on disk', () => {
  it('takes the catalog’s word for it when the bytes are the catalog’s bytes', () => {
    // 后端那张内置表认不出的社区新版：清单认得出来，就该按清单说。
    expect(installedVariantId(status({ variant: null, variantLabel: null, dllSha256: COMMUNITY }), published())).toBe('community');
  });

  it('falls back to the built-in table while the catalog is offline', () => {
    expect(installedVariantId(status(), undefined)).toBe('official');
    expect(installedVariantId(status({ variant: 'sf-v2' }), undefined)).toBe('sf-v2');
  });

  it('says nothing when nothing is installed', () => {
    expect(installedVariantId(status({ dllPresent: false, variant: null, dllBytes: null, dllSha256: null }), published())).toBeUndefined();
  });
});

describe('available snippet updates', () => {
  it('reports the same community variant republished with other bytes', () => {
    // 盘上是老的那一份 community（内置表按老哈希认出来），清单里那条已经换了资产：
    // 这一条该显示「有更新」，而且报的就是**这一条**——不是别的变体。
    const updates = availableVariantUpdates(
      status({ variant: 'community', variantLabel: 'Lecram 版', dllSha256: STRANGER, dllBytes: 165_840_496 }),
      published(),
    );
    expect(updates).toEqual([{
      id: 'community',
      label: 'Lecram 版',
      asset: 'nvngx_dlssnr--community.dll',
      size: 165_840_496,
      sha256: COMMUNITY,
      installedVersion: '310.8.0.0',
    }]);
  });

  it('leaves the variant alone when the catalog carries the bytes already installed', () => {
    expect(availableVariantUpdates(status({ dllSha256: OFFICIAL }), published())).toEqual([]);
    expect(availableVariantUpdates(status({ variant: 'community', dllSha256: COMMUNITY }), published())).toEqual([]);
  });

  it('does not let a change to one variant speak for another', () => {
    // 官方原版装得好好的，社区那条换了资产：官方这一条不该被报成「有更新」。
    const moved = catalog([
      variant({ id: 'official', label: '官方', size: 165_840_496, sha256: OFFICIAL }),
      variant({ id: 'community', label: '社区', size: 165_840_496, sha256: 'b'.repeat(64) }),
    ]);
    expect(availableVariantUpdates(status({ dllSha256: OFFICIAL }), moved)).toEqual([]);
  });

  it('ignores case and stray spaces in either hash', () => {
    const catalogUpper = catalog([variant({ id: 'official', label: '官方', size: 165_840_496, sha256: ` ${OFFICIAL.toUpperCase()} ` })]);
    expect(availableVariantUpdates(status({ dllSha256: OFFICIAL.toUpperCase() }), catalogUpper)).toEqual([]);
  });

  it('refuses to compare by size when the hash cannot be read', () => {
    // 哈希读不出来（老后端、半截文件）时只剩字节数可比，而官方与社区字节数一模一样：
    // 这时候说「有更新」等于凭猜让用户重下一份 165 MB 的东西。
    const missing = status({ variant: 'community', dllSha256: null, dllBytes: 165_840_496 });
    expect(availableVariantUpdates(missing, published())).toEqual([]);
  });

  it('says nothing about a snippet nobody recognises', () => {
    expect(availableVariantUpdates(status({ variant: null, dllSha256: STRANGER }), published())).toEqual([]);
  });

  it('says nothing while the catalog is not there', () => {
    expect(availableVariantUpdates(status({ variant: 'community', dllSha256: STRANGER }), undefined)).toEqual([]);
  });
});
