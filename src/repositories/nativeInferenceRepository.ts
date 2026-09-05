import { z } from 'zod';
import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

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
});
const InferenceCacheClearResultSchema = z.object({ entriesCleared: z.number().int().nonnegative() });
export type InferenceJob = z.infer<typeof InferenceJobSchema>;
export interface InferenceStartInput { id: string; sourceScope: string; sourceId: string; modelId: string; modelVersion: string; inputHashes: string[]; }
export interface InferenceCheckpointInput { jobId: string; itemIndex: number; completedTile: number; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; outputPath?: string; }
export interface ModelManifest { id: string; version: string; format: 'onnx'; scale: number; maxPixels: number; sha256: string; supportedBackends: string[]; }
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
  /** Upscales one cached reader page; the result is stored as the `enhanced`
   * rendition, keyed by scale and model version. */
  /** `modelId` names an installed model; the native side resolves its newest
   * version and reads the scale from that model's manifest, so the caller does
   * not get to ask for a scale the model cannot produce. */
  upscalePage(input: { scopeId: string; archiveId: string; pageIndex: number; scale?: number; modelId?: string; tileSize?: number; tileSleepMs?: number }): Promise<CommandResult<ArrayBuffer>> {
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
  checkpoint(input: InferenceCheckpointInput): Promise<CommandResult<void>> { return invokeCommand('inference_checkpoint', { input }, z.undefined()); }
  pause(id: string): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_pause', { id }, InferenceJobSchema); }
  resume(id: string): Promise<CommandResult<InferenceJob>> { return invokeCommand('inference_resume', { id }, InferenceJobSchema); }
  validateModel(manifest: ModelManifest, model: number[]): Promise<CommandResult<void>> { return invokeCommand('inference_validate_model', { input: { manifest, model } }, z.undefined()); }
  installModel(manifest: ModelManifest, archive: number[]): Promise<CommandResult<InstalledModel>> { return invokeCommand('inference_install_model', { input: { manifest, archive } }, InstalledModelResponse); }
  /** The models actually on disk, so the settings page can offer a choice
   * instead of asking for a model name to be typed from memory. */
  listModels(): Promise<CommandResult<InstalledModel[]>> { return invokeCommand('inference_list_models', {}, z.array(InstalledModelResponse)); }
  clearCache(): Promise<CommandResult<InferenceCacheClearResult>> { return invokeCommand('inference_clear_cache', {}, InferenceCacheClearResultSchema); }
}
