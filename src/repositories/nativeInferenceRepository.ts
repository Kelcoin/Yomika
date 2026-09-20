import { z } from 'zod';
import { invokeBinaryCommand, invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import { buildModelAssetUrl, mirrorPrefix, type ModelMirrorId } from '../domain/modelRelease';

const CpuRgbaOutputSchema = z.object({
  rgba: z.array(z.number().int().min(0).max(255)),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const InferenceCapabilitiesSchema = z.object({
  backends: z.array(z.string().min(1)), maxPixels: z.number().int().positive(), hardwareAcceleration: z.boolean(),
});
const InferenceJobSchema = z.object({ id: z.string().min(1), status: z.string().min(1), itemCount: z.number().int().nonnegative(), completedCount: z.number().int().nonnegative() });
const InstalledModelSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  /** From the installed manifest. Null means the directory has no manifest, so
   * the model is listed but cannot be run — nothing records its scale. */
  scale: z.number().int().positive().nullable().default(null),
  /** What the model does. Read from the shape of the install on the native side,
   * so a de-censoring bundle cannot be offered as an upscaler — picking one there
   * silently produced plain nearest-neighbour output. */
  kind: z.enum(['upscale', 'decensor']).default('upscale'),
  components: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), path: z.string() })).default([]),
});
const InferenceCacheClearResultSchema = z.object({ entriesCleared: z.number().int().nonnegative() });
/** 托管模型的目录清单。`directUrl` 是上游那份导出（HuggingFace），本仓库的
 * Release 资产是它下载不到时的兜底。 */
const UpscaleCatalogSchema = z.object({
  tag: z.string().min(1),
  models: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    scale: z.number().int().positive(),
    version: z.string().min(1),
    source: z.string().nullish(),
    /** 图的最小可接受边长；缺省表示图对尺寸没要求。 */
    minInputEdge: z.number().int().positive().nullish(),
    files: z.array(z.object({
      name: z.string().min(1),
      size: z.number().int().positive(),
      sha256: z.string().length(64),
      directUrl: z.string().nullish(),
    })).min(1),
  })),
});
export type UpscaleCatalog = z.infer<typeof UpscaleCatalogSchema>;
export type UpscaleCatalogModel = UpscaleCatalog['models'][number];
export type InferenceJob = z.infer<typeof InferenceJobSchema>;
export interface InferenceStartInput { id: string; sourceScope: string; sourceId: string; modelId: string; modelVersion: string; inputHashes: string[]; }
export interface InferenceCheckpointInput { jobId: string; itemIndex: number; completedTile: number; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; outputPath?: string; }
export interface ModelManifest { id: string; version: string; format: 'onnx'; scale: number; maxPixels: number; sha256: string; supportedBackends: string[]; /** 图能接受的最小边长（源像素）。Real-CUGAN 的 18px 反射 pad 要求每边 ≥20；
 * 引擎会把更细的块补到这么大再裁回来。缺省 1，等于不动。 */ minInputEdge?: number; }
export type InferenceCapabilities = z.infer<typeof InferenceCapabilitiesSchema>;
/** `z.infer` gives the input type, where a defaulted field is optional; commands
 * answer with the filled-in shape. */
export type InstalledModel = z.output<typeof InstalledModelSchema>;
const InstalledModelResponse = InstalledModelSchema as unknown as z.ZodType<InstalledModel>;
export type InferenceCacheClearResult = z.infer<typeof InferenceCacheClearResultSchema>;

export interface CpuScaleInput {
  rgba: number[];
  width: number;
  height: number;
  scale: number;
  maxPixels: number;
}

export type CpuRgbaOutput = z.infer<typeof CpuRgbaOutputSchema>;

export class NativeInferenceRepository {
  validateReleaseManifest(manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate', { manifest }, VoidResponseSchema);
  }

  downloadReleaseAsset(input: { url: string; asset: unknown; destination: string }): Promise<CommandResult<void>> {
    return invokeCommand('model_release_download', { input }, VoidResponseSchema);
  }

  downloadModelBundle(input: { prefix: string; ownerRepo: string; manifest: unknown; destination: string }): Promise<CommandResult<void>> {
    return invokeCommand('model_release_download_bundle', { input }, VoidResponseSchema);
  }
  downloadDefaultModel(modelId?: string): Promise<CommandResult<void>> {
    return invokeCommand('model_release_download_default', modelId ? { modelId } : {}, VoidResponseSchema);
  }

  validateModelImport(root: string, manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate_import', { input: { root, manifest } }, VoidResponseSchema);
  }

  cancelReleaseDownload(destination: string): Promise<CommandResult<void>> {
    return invokeCommand('model_release_cancel', { destination }, VoidResponseSchema);
  }

  validateModelArchive(archive: number[], manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate_archive', { input: { archive, manifest } }, VoidResponseSchema);
  }

  activateModelDirectory(staging: string, install: string): Promise<CommandResult<void>> {
    return invokeCommand('model_release_activate', { input: { staging, install } }, VoidResponseSchema);
  }

  validateLocalModel(path: string, manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate_local', { input: { path, manifest } }, VoidResponseSchema);
  }

  releaseAssetUrl(prefix: string, ownerRepo: string, tag: string, path: string): Promise<CommandResult<string>> {
    return invokeCommand('model_release_url', { prefix, ownerRepo, tag, path }, z.string());
  }

  fetchReleaseManifest(prefix: string, ownerRepo: string, tag: string): Promise<CommandResult<unknown>> {
    return invokeCommand('model_release_fetch_manifest', { prefix, ownerRepo, tag }, z.unknown());
  }
  static modelAssetUrl(mirror: ModelMirrorId, ownerRepo: string, tag: string, path: string, customPrefix = ''): string {
    return buildModelAssetUrl(mirrorPrefix(mirror, customPrefix), ownerRepo, tag, path);
  }
  /** Upscales one cached reader page; the result is stored as the `enhanced`
   * rendition, keyed by scale and model version. */
  /** `modelId` names an installed model; the native side resolves its newest
   * version and reads the scale from that model's manifest, so the caller does
   * not get to ask for a scale the model cannot produce. */
  /** `decensorModel` chains the two pipelines: the upscaler then reads this
   * page's de-censored rendition instead of the plain one. */
  upscalePage(input: { scopeId: string; archiveId: string; pageIndex: number; scale?: number; modelId?: string; decensorModel?: string; tileSize?: number; tileSleepMs?: number }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('inference_upscale_page', { input });
  }

  /** Runs the de-censoring bundle over one cached reader page; the result is
   * stored as the `decensored` rendition, keyed by bundle version. */
  decensorPage(input: { scopeId: string; archiveId: string; pageIndex: number; modelId: string }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('inference_decensor_page', { input });
  }

  probe(): Promise<CommandResult<InferenceCapabilities>> {
    return invokeCommand('inference_probe', {}, InferenceCapabilitiesSchema);
  }

  cpuScale(input: CpuScaleInput): Promise<CommandResult<CpuRgbaOutput>> {
    return invokeCommand('inference_cpu_scale', { input }, CpuRgbaOutputSchema);
  }

  start(input: InferenceStartInput): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_start', { input }, InferenceJobSchema); }
  getJob(id: string): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_get_job', { id }, InferenceJobSchema); }
  cancel(id: string): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_cancel', { id }, InferenceJobSchema); }
  checkpoint(input: InferenceCheckpointInput): Promise<CommandResult<void>> { return invokeCommand('inference_checkpoint', { input }, VoidResponseSchema); }
  pause(id: string): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_pause', { id }, InferenceJobSchema); }
  resume(id: string): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_resume', { id }, InferenceJobSchema); }
  validateModel(manifest: ModelManifest, model: number[]): Promise<CommandResult<void>> { return invokeCommand('inference_validate_model', { input: { manifest, model } }, VoidResponseSchema); }
  installModel(manifest: ModelManifest, archive: number[]): Promise<CommandResult<InstalledModel>> { return invokeCommand('inference_install_model', { input: { manifest, archive } }, InstalledModelResponse); }
  /** 导入走磁盘路径而不是字节：几百 MB 的包拆成 number[] 过 JSON 桥，
   * 一进一出要占十几倍内存还会冻结主线程；由 Rust 直接读路径。 */
  importModelPath(path: string): Promise<CommandResult<InstalledModel>> { return invokeCommand('inference_import_model_path', { input: { path } }, InstalledModelResponse); }
  /** The models actually on disk, so the settings page can offer a choice
   * instead of asking for a model name to be typed from memory. */
  /** Installs a de-censoring bundle by copying it out of a directory the user
   * already has. The bundle is 337 MB, so it cannot be handed over as bytes the
   * way an upscaling model is. */
  installDecensorBundle(sourceDir: string): Promise<CommandResult<InstalledModel>> { return invokeCommand('inference_install_decensor_bundle', { sourceDir }, InstalledModelResponse); }
  listModels(): Promise<CommandResult<InstalledModel[]>> { return invokeCommand('inference_list_models', {}, z.array(InstalledModelResponse)); }
  /** 线上托管的超分模型目录。装在盘上的模型和它能选什么不是一回事：目录里的
   * 条目还没下载，设置页也要列出来——否则手机端永远没有 real-esrgan 可选。 */
  listUpscaleCatalog(): Promise<CommandResult<UpscaleCatalog>> { return invokeCommand('model_release_list_upscalers', {}, UpscaleCatalogSchema); }
  clearCache(): Promise<CommandResult<InferenceCacheClearResult>> { return invokeCommand('inference_clear_cache', {}, InferenceCacheClearResultSchema); }
}
