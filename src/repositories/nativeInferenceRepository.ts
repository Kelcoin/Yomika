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
const InstalledModelSchema = z.object({ id: z.string().min(1), version: z.string().min(1) });
const InferenceCacheClearResultSchema = z.object({ entriesCleared: z.number().int().nonnegative() });
export type InferenceJob = z.infer<typeof InferenceJobSchema>;
export interface InferenceStartInput { id: string; sourceScope: string; sourceId: string; modelId: string; modelVersion: string; inputHashes: string[]; }
export interface InferenceCheckpointInput { jobId: string; itemIndex: number; completedTile: number; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; outputPath?: string; }
export interface ModelManifest { id: string; version: string; format: 'onnx'; scale: number; maxPixels: number; sha256: string; supportedBackends: string[]; }
export type InferenceCapabilities = z.infer<typeof InferenceCapabilitiesSchema>;
export type InstalledModel = z.infer<typeof InstalledModelSchema>;
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
  upscalePage(input: { scopeId: string; archiveId: string; pageIndex: number; scale?: number; modelVersion?: string; tileSize?: number; tileSleepMs?: number }): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('inference_upscale_page', { input });
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
  installModel(manifest: ModelManifest, archive: number[]): Promise<CommandResult<InstalledModel>> { return invokeCommand('inference_install_model', { input: { manifest, archive } }, InstalledModelSchema); }
  clearCache(): Promise<CommandResult<InferenceCacheClearResult>> { return invokeCommand('inference_clear_cache', {}, InferenceCacheClearResultSchema); }
}
