import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
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
  validateReleaseManifest(manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate', { manifest }, z.undefined());
  }

  downloadReleaseAsset(input: { url: string; asset: unknown; destination: string }): Promise<CommandResult<void>> {
    return invokeCommand('model_release_download', { input }, z.undefined());
  }

  downloadModelBundle(input: { prefix: string; ownerRepo: string; manifest: unknown; destination: string }): Promise<CommandResult<void>> {
    return invokeCommand('model_release_download_bundle', { input }, z.undefined());
  }

  validateModelImport(root: string, manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate_import', { input: { root, manifest } }, z.undefined());
  }

  cancelReleaseDownload(destination: string): Promise<CommandResult<void>> {
    return invokeCommand('model_release_cancel', { destination }, z.undefined());
  }

  validateModelArchive(archive: number[], manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate_archive', { input: { archive, manifest } }, z.undefined());
  }

  activateModelDirectory(staging: string, install: string): Promise<CommandResult<void>> {
    return invokeCommand('model_release_activate', { input: { staging, install } }, z.undefined());
  }

  validateLocalModel(path: string, manifest: unknown): Promise<CommandResult<void>> {
    return invokeCommand('model_release_validate_local', { input: { path, manifest } }, z.undefined());
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
