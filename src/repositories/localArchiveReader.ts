import { z } from 'zod';
import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import { ComputedImageLeaseSchema } from '../domain/compute';

const index = z.number().int().nonnegative();
const manifest = z.object({ title: z.string(), tags: z.array(z.string()), sizeBytes: index, entries: z.array(index).nonempty() });
const progress = z.object({ pageIndex: index, continuous: z.boolean() });
export type LocalArchiveManifest = z.infer<typeof manifest>;
export type LocalArchiveProgress = z.infer<typeof progress>;

export function localReaderUrl(path: string, page?: number) {
  const params = new URLSearchParams({ file: path });
  if (page !== undefined) params.set('page', String(page));
  return `/reader/local/file?${params}`;
}

export function loadLocalArchiveManifest(path: string) {
  return invokeCommand('load_local_archive_manifest', { path }, manifest);
}

export async function loadLocalArchivePage(path: string, entry: number) {
  const result = await invokeCommand('load_local_archive_page', { path, entry }, z.string());
  return result.ok ? result.value : undefined;
}

export async function loadLocalArchiveOriginal(path: string, entry: number) {
  return invokeBinaryCommand('load_local_archive_original', { path, entry });
}

export function openLocalArchiveReaderFile(path: string, entry: number, taskId: string, readerSession: number, pageIndex: number) {
  return invokeCommand('open_local_archive_reader_file', { path, entry, taskId, readerSession, pageIndex }, z.object({
    lease: ComputedImageLeaseSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable());
}

const writes = new Map<string, Promise<unknown>>();
export async function loadLocalArchiveProgress(path: string) {
  await writes.get(path);
  return invokeCommand('local_archive_progress', { path }, progress.nullable());
}

export function saveLocalArchiveProgress(path: string, value: LocalArchiveProgress, allowRegression: boolean) {
  const request = Promise.resolve(writes.get(path)).then(() =>
    invokeCommand('local_archive_progress', { path, progress: value, allowRegression }, progress.nullable()));
  const tail = request.catch(() => undefined);
  writes.set(path, tail);
  void tail.then(() => { if (writes.get(path) === tail) writes.delete(path); });
  return request;
}
