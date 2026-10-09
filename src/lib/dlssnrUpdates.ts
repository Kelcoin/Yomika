import type { DlssnrCatalog, DlssnrStatus } from '../repositories/nativeDlssnrRepository';

/** 清单里那一条换过资产之后，界面要请用户重下的那一条。 */
export interface DlssnrVariantUpdate {
  id: string;
  label: string;
  /** 下载时用到的资产名（后端按它拼 URL、也按它落盘）。 */
  asset: string;
  size: number;
  sha256: string;
  /** 盘上那一份自己报的版本号（`310.8.0.0`）；读不出来就没有。 */
  installedVersion?: string | undefined;
}

/** 两份哈希是不是同一份字节：大小写与两边的空白都不算数。 */
function sameDigest(left: string | null | undefined, right: string | null | undefined): boolean {
  const one = left?.trim().toLowerCase();
  const other = right?.trim().toLowerCase();
  return Boolean(one) && one === other;
}

/**
 * 盘上那份片段是清单里的哪一条。
 *
 * 先按 SHA-256 找：清单是**活的**权威——社区把同一条变体重发一份新字节，后端那张
 * 硬编码的内置表立刻就不认识了，而清单仍认得出「这还是 community」。
 *
 * 清单没到（离线、第一次启动）时退回内置表认出来的 id：那时只知道「是官方 / 社区 /
 * SF-v2 三者之一」，也够界面把已装的那一条点亮。
 */
export function installedVariantId(
  status: DlssnrStatus | undefined,
  catalog: DlssnrCatalog | undefined,
): string | undefined {
  if (!status?.dllPresent) return undefined;
  const digest = status.dllSha256;
  if (digest) {
    const hit = catalog?.variants.find((variant) => sameDigest(variant.sha256, digest));
    if (hit) return hit.id;
  }
  return status.variant ?? undefined;
}

/**
 * 清单里哪一条换了资产（要请用户重下）。
 *
 * **比的是 SHA-256，不是字节数**：官方原版与社区兼容版都是 165,840,496 字节，按
 * 字节数比会把「同一条社区版重发」和「换成了另一种变体」混成一件事，也会在用户
 * 手里那份读不出哈希时凭猜报更新——那意味着让他白下 165 MB。
 *
 * 认不出装的是哪一条、或哈希读不出来时**什么都不报**：不猜。
 */
export function availableVariantUpdates(
  status: DlssnrStatus | undefined,
  catalog: DlssnrCatalog | undefined,
): DlssnrVariantUpdate[] {
  const id = installedVariantId(status, catalog);
  const installed = status?.dllSha256;
  if (!id || !installed?.trim() || !catalog) return [];
  const variant = catalog.variants.find((entry) => entry.id === id);
  if (!variant || sameDigest(variant.sha256, installed)) return [];
  return [{
    id: variant.id,
    label: variant.label,
    asset: variant.asset,
    size: variant.size,
    sha256: variant.sha256,
    installedVersion: status?.dllVersion ?? undefined,
  }];
}
