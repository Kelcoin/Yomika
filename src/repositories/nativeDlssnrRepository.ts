import { z } from 'zod';

import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

/** 一台能用的 N 卡（DLSSNR 的显卡信息）。 */
export const DlssnrGpuSchema = z.object({
  name: z.string(),
  /** 这一代该用哪一种变体（`official` / `community` / `sf-v2`）。 */
  recommendedVariant: z.string().nullable().optional(),
});

/** 库里的一种已装片段（`data/dlssnr/variants/` 里的一个文件）。
 *
 * 下载不再顶掉别的版本：每一个变体各占库里的一个文件，固定名那份才是阅读器真正用的。
 * `id` / `label` 为空代表这份文件的字节认不出是哪一条目录里的变体（自己塞进来的、
 * 改过的、目录里已经下架的）；`active` 是**此刻**正在用的那一种。
 */
export const DlssnrInstalledVariantSchema = z.object({
  /** 目录里的变体 id（`official` / `community` / `sf-v2`…）；认不出就是 null。 */
  id: z.string().nullable(),
  /** 后端认出来的名字；认不出就是 null。 */
  label: z.string().nullable(),
  bytes: z.number(),
  active: z.boolean(),
  /** 库目录里的文件名，认不出的片段靠它才叫得出来。 */
  file: z.string(),
});

export type DlssnrInstalledVariant = z.output<typeof DlssnrInstalledVariantSchema>;

/** 这台机器上 DLSSNR 的现状。全是便宜事实：枚举显卡、看文件在不在、认哈希。 */
export const DlssnrStatusSchema = z.object({
  dllPresent: z.boolean(),
  variant: z.string().nullable(),
  variantLabel: z.string().nullable(),
  dllBytes: z.number().nullable(),
  /** 这份 DLL 自己报的版本号（`310.8.0.0`）。读不出来（不是 PE、被截断）就是 null，
   * 老版本后端没有这个字段，所以是可选的。 */
  dllVersion: z.string().nullable().optional(),
  /** 盘上这份片段的 SHA-256。**不能拿字节数代替**：官方原版与Lecram 版都是
   * 165,840,496 字节，只有哈希分得开。老版本后端没有这个字段，所以是可选的。 */
  dllSha256: z.string().nullable().optional(),
  /** 这台机器上装过的每一种（一个变体一个文件），按文件名排。认不出的文件也在里面，
   * 这样设置页才看得见「为什么下了一个版本会顶掉别的」已经不再发生。
   * 老版本后端没有这个字段，所以是可选的。 */
  installedVariants: z.array(DlssnrInstalledVariantSchema).optional(),
  gpu: DlssnrGpuSchema.nullable().optional(),
  gpuName: z.string(),
  recommendedVariant: z.string().nullable(),
  recommendedLabel: z.string().nullable(),
  coreAvailable: z.boolean(),
  /** 设置页该不该显示这一组：支持系列的 N 卡 + 有这个构建的核心（不要求已装片段）。 */
  installable: z.boolean(),
  /** 现在就跑得起来：在上面的基础上还装了片段。 */
  available: z.boolean(),
  /** 上次可选诊断的结论（没跑过就是 null）。 */
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
  /** 刚装上的这一份报的版本号（导入/下载的回执上带着，用户点完就知道装的是哪一版）。 */
  version: z.string().nullable().optional(),
});

const ImportedDllSchema = InstalledDllSchema.extend({
  /** 独立 worker 在本机运行候选 DLL 的结果；只保证这次测试尺寸。 */
  verification: DlssnrProbeSchema,
});

/** 一层 DLSSNR 的参数：与后端 `dlssnr::PassSettings` 一一对应。 */
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

/** 最多五层：同一张图串行跑几个 pass。上限只此一处，与 Rust 侧的
 *  `dlssnr::settings::MAX_PASS_COUNT` 对齐——两边差一个数就会「加得上但存不下」，
 *  或者反过来「存得下却加不上」。 */
export const MAX_DLSSNR_PASSES = 5;

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

  importDll(path: string): Promise<CommandResult<z.output<typeof ImportedDllSchema>>> {
    return invokeCommand('dlssnr_import_dll', { path }, ImportedDllSchema);
  }

  /** 有哪些变体可选（模型仓库里的那份清单）。 */
  catalog(): Promise<CommandResult<DlssnrCatalog>> {
    return invokeCommand('dlssnr_catalog', {}, DlssnrCatalogSchema);
  }

  /** 下载某一条变体装进库里，并把它放到固定名上给阅读器用。
   *
   * 库里其它版本一个都不动：每一条各占自己的文件，所以下了一个版本不会顶掉别的版本；
   * 想换回去用 `activateVariant`。 */
  downloadVariant(variantId: string): Promise<CommandResult<z.output<typeof InstalledDllSchema>>> {
    return invokeCommand('dlssnr_download_variant', { variantId }, InstalledDllSchema);
  }

  /** 换成库里已经装过的另一种，不用重新下载。
   *
   * `variantId` 收目录里的变体 id，也收库里的完整文件名（认不出的片段只有文件名可用）。
   * 后端动手之前会先退掉计算进程（片段映在它身上），所以换完**不用重启应用**，
   * 下一页会重新算。 */
  activateVariant(variantId: string): Promise<CommandResult<z.output<typeof InstalledDllSchema>>> {
    return invokeCommand('dlssnr_activate_variant', { variantId }, InstalledDllSchema);
  }

  /** 拿缓存里的一页跑一遍，回 PNG 字节。
   *
   * `source` 说从哪一版开始：原图，或者本地超分那一步的产物。起点是按「产出它的模型」
   * 存的，所以读超分产物时要把那个模型 id 一并给出——原生那侧据此算出同一个 revision，
   * 才不会读到别的模型写下的图。 */
  applyPage(input: {
    scopeId: string;
    archiveId: string;
    pageIndex: number;
    source?: 'reader-page' | 'enhanced';
    upscaleModel?: string;
    settings: { passes: DlssnrPass[] };
    taskId?: string;
    /** `foreground`＝用户正看的那一页，排在后台预扫前面；后台正在跑时会被取消。 */
    priority?: 'foreground' | 'background';
  }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('dlssnr_apply_page', { input });
  }
}
