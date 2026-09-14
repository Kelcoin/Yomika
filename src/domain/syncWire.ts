import { z } from 'zod';

export const BuiltSyncSegmentSchema = z.object({
  sequenceStart: z.number().int().positive(),
  sequenceEnd: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  ciphertext: z.array(z.number().int().min(0).max(255)),
});

export type BuiltSyncSegment = z.infer<typeof BuiltSyncSegmentSchema>;

export const SyncManifestSegmentSchema = z.object({
  hash: z.string().min(1),
  size: z.number().int().nonnegative(),
  sequenceStart: z.number().int().positive(),
  sequenceEnd: z.number().int().positive(),
});

export const SyncManifestSchema = z.object({
  version: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  segments: z.array(SyncManifestSegmentSchema),
  deviceCursors: z.record(z.string(), z.number().int().nonnegative()),
});
export type SyncManifest = z.infer<typeof SyncManifestSchema>;

export const WebdavAccountSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  baseUrl: z.string().url(),
  username: z.string(),
  credentialRef: z.string().min(1),
  status: z.string().min(1),
  lastProbeAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type WebdavAccount = z.infer<typeof WebdavAccountSchema>;

export const SyncKeyExportSchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(1),
});

export type SyncKeyExport = z.infer<typeof SyncKeyExportSchema>;

export const SyncKeyImportSchema = z.object({
  fingerprint: z.string().min(1),
  verified: z.boolean().nullable(),
});

export type SyncKeyImport = z.infer<typeof SyncKeyImportSchema>;

export type SaveWebdavAccountInput = {
  id: string;
  label: string;
  baseUrl: string;
  username: string;
  credential: string;
};
