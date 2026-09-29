import { z } from 'zod';

import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

/** 一台能用的 N 卡（DLSS5 的显卡信息）。 */
export const DlssnrGpuSchema = z.object({
  name: z.string(),
  /** 这一代该用哪一种变体（`official` / `community` / `sf-v2`）。 */
  recommendedVariant: z.string().nullable().optional(),
});

/** 这台机器上 DLSS5 的现状。全是便宜事实：枚举显卡、看文件在不在、认哈希。 */
export const DlssnrStatusSchema = z.object({
  dllPresent: z.boolean(),
  variant: z.string().nullable(),
  variantLabel: z.string().nullable(),
  dllBytes: z.number().nullable(),
  gpu: DlssnrGpuSchema.nullable().optional(),
  gpuName: z.string(),
  recommendedVariant: z.string().nullable(),
  recommendedLabel: z.string().nullable(),
  coreAvailable: z.boolean(),
  /** 设置页该不该显示这一组：支持系列的 N 卡 + 有这个构建的核心（不要求已装片段）。 */
  installable: z.boolean(),
  /** 现在就跑得起来：在上面的基础上还装了片段。 */
  available: z.boolean(),
  /** 上次检测的结论（没跑过就是 null）。开关看它解不解锁。 */
  probe: z
    .object({
      supported: z.boolean(),
      width: z.number(),
      height: z.number(),
      elapsedMs: z.number(),
      difference: z.number(),
      error: z.string().nullable(),
    })
    .nullable(),
  /** 上面那份结论是不是对**现在这一份 DLL** 跑的。换过片段之后就不算数了：阅读器
   * 不该据旧结论排队，设置页也该请用户重新检测（换过 DLL 还要重启）。 */
  probeValid: z.boolean(),
  /** 差什么：不是 N 卡、没装 DLL、没有核心…… */
  error: z.string().nullable(),
});

export type DlssnrStatus = z.output<typeof DlssnrStatusSchema>;

export const DlssnrProbeSchema = z.object({
  supported: z.boolean(),
  width: z.number(),
  height: z.number(),
  elapsedMs: z.number(),
  difference: z.number(),
  error: z.string().nullable(),
});

export type DlssnrProbe = z.output<typeof DlssnrProbeSchema>;

/** 片段目录里的一条变体（模型仓库那份 `dlssnr-manifest.json` 的一个条目）。 */
export const DlssnrVariantSchema = z.object({
  /** `official` / `community` / `sf-v2`。 */
  id: z.string(),
  label: z.string(),
  note: z.string().default(''),
  /** 这一条面向哪几代卡（只作说明）。 */
  series: z.array(z.number()).default([]),
  /** Release 资产的平铺文件名，也是下载时的落盘名。 */
  asset: z.string(),
  size: z.number(),
  sha256: z.string(),
});

export type DlssnrVariant = z.output<typeof DlssnrVariantSchema>;

export const DlssnrCatalogSchema = z.object({
  tag: z.string(),
  /** 片段内嵌的 NVIDIA 许可（要求随包分发全文的那一份）。 */
  license: z
    .object({ name: z.string(), asset: z.string(), size: z.number(), sha256: z.string() })
    .nullable()
    .optional(),
  variants: z.array(DlssnrVariantSchema),
});

export type DlssnrCatalog = z.output<typeof DlssnrCatalogSchema>;

const InstalledDllSchema = z.object({
  bytes: z.number(),
  variant: z.string().nullable(),
  variantLabel: z.string().nullable(),
});

/** 一层 DLSS5 的参数：与后端 `dlssnr::PassSettings` 一一对应。 */
export const DlssnrPassSchema = z
  .object({
    /** 0 默认 / 1 自然 / 2 电影。 */
    style: z.number().int().min(0).max(2).default(0),
    intensity: z.number().min(0).max(2).default(1),
    localToneStrength: z.number().min(0).max(2).default(1),
    localStructureStrength: z.number().min(0).max(2).default(1),
    skinStructureStrength: z.number().min(0).max(2).default(0),
    /** 自动遮罩：让网络自己圈出该处理的地方。 */
    autoMask: z.boolean().default(false),
    /** 界面修正：文字与线条保持原样（漫画里的拟声词、边框）。 */
    uiCorrection: z.boolean().default(false),
  })
  .strip();

export type DlssnrPass = z.output<typeof DlssnrPassSchema>;

export const MAX_DLSSNR_PASSES = 3;

export const DEFAULT_DLSSNR_PASS: DlssnrPass = {
  style: 0,
  intensity: 1,
  localToneStrength: 1,
  localStructureStrength: 1,
  skinStructureStrength: 0,
  autoMask: false,
  uiCorrection: false,
};

/** 把偏好里那段 JSON 读成层参数：坏数据一律回一层默认，不让设置页崩。 */
export function parseDlssnrPasses(encoded: string): DlssnrPass[] {
  if (!encoded.trim()) return [DEFAULT_DLSSNR_PASS];
  try {
    const parsed = z.array(DlssnrPassSchema).max(MAX_DLSSNR_PASSES).safeParse(JSON.parse(encoded));
    if (!parsed.success || parsed.data.length === 0) return [DEFAULT_DLSSNR_PASS];
    return parsed.data;
  } catch {
    return [DEFAULT_DLSSNR_PASS];
  }
}

export function serializeDlssnrPasses(passes: DlssnrPass[]): string {
  return JSON.stringify(passes.slice(0, MAX_DLSSNR_PASSES));
}

export class NativeDlssnrRepository {
  status(): Promise<CommandResult<DlssnrStatus>> {
    return invokeCommand('dlssnr_status', {}, DlssnrStatusSchema);
  }

  /** 真机跑一遍；`force` 为假时后端给上次的结论。 */
  probe(force = true): Promise<CommandResult<DlssnrProbe>> {
    return invokeCommand('dlssnr_probe', { force }, DlssnrProbeSchema);
  }

  importDll(path: string): Promise<CommandResult<z.output<typeof InstalledDllSchema>>> {
    return invokeCommand('dlssnr_import_dll', { path }, InstalledDllSchema);
  }

  /** 有哪些变体可选（模型仓库里的那份清单）。 */
  catalog(): Promise<CommandResult<DlssnrCatalog>> {
    return invokeCommand('dlssnr_catalog', {}, DlssnrCatalogSchema);
  }

  /** 下载某一条变体并装进数据目录（旧的被换掉）。 */
  downloadVariant(variantId: string): Promise<CommandResult<z.output<typeof InstalledDllSchema>>> {
    return invokeCommand('dlssnr_download_variant', { variantId }, InstalledDllSchema);
  }

  /** 拿缓存里的一页跑一遍，回 PNG 字节。
   *
   * `source` 说从哪一版开始：原图，或者本地那两步（去码 / 超分）的产物。起点是按
   * 「产出它的模型」存的，所以读去码/超分产物时要把那两个模型 id 一并给出——原生
   * 那侧据此算出同一个 revision，才不会读到别的模型写下的图。 */
  applyPage(input: {
    scopeId: string;
    archiveId: string;
    pageIndex: number;
    source?: 'reader-page' | 'decensored' | 'enhanced';
    decensorModel?: string;
    upscaleModel?: string;
    settings: { passes: DlssnrPass[] };
    taskId?: string;
  }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('dlssnr_apply_page', { input });
  }
}
