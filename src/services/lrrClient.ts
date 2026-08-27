import { z } from 'zod';
import { err, ok, type CommandResult } from '../domain/result';
import { normalizeServerUrl } from '../domain/server';

const ServerInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

export type ServerInfo = z.infer<typeof ServerInfoSchema>;

const ArchiveMetadataSchema = z.object({
  arcid: z.string().refine((value) => /^[0-9a-f]{40}$/.test(value) || /^TANK_[0-9]{10}$/.test(value)),
  title: z.string(),
  filename: z.string(),
  tags: z.string(),
  summary: z.string().nullable().optional(),
  isnew: z.union([z.boolean(), z.string(), z.null()]),
  extension: z.string(),
  progress: z.number().int(),
  pagecount: z.number().int().nonnegative(),
  lastreadtime: z.number().int(),
  size: z.number().int().nonnegative(),
});

const SearchResponseSchema = z.object({
  data: z.array(ArchiveMetadataSchema),
  recordsFiltered: z.number().int().nonnegative(),
  recordsTotal: z.number().int().nonnegative(),
});

const ArchiveFilesResponseSchema = z.object({
  pages: z.array(z.string().min(1)),
  job: z.number().int().nullable().optional(),
});

export interface SearchArchivesRequest {
  category?: string;
  filter?: string;
  start?: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
  newOnly?: boolean;
  untaggedOnly?: boolean;
  hideCompleted?: boolean;
  groupByTankoubons?: boolean;
}

export interface SearchArchive {
  archiveId: string;
  title: string;
  filename: string;
  tags: string;
  summary?: string;
  extension: string;
  progress: number;
  pageCount: number;
  lastReadTime: number;
  size: number;
}

export interface SearchArchivesResponse {
  data: SearchArchive[];
  recordsFiltered: number;
  recordsTotal: number;
}

export interface ArchiveMetadata {
  archiveId: string;
  title: string;
  filename: string;
  tags: string;
  summary?: string;
  extension: string;
  progress: number;
  pageCount: number;
  lastReadTime: number;
  size: number;
}

interface LrrClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetcher?: typeof fetch;
}

export class LrrHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: LrrClientOptions) {
    this.baseUrl = normalizeServerUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? fetch;
  }

  async getServerInfo(signal?: AbortSignal): Promise<CommandResult<ServerInfo>> {
    try {
      const init: RequestInit = {
        headers: this.authenticationHeaders(),
      };
      if (signal) init.signal = signal;
      const response = await this.fetcher(`${this.baseUrl}/api/info`, init);
      if (!response.ok) return this.httpError(response.status);
      const parsed = ServerInfoSchema.safeParse(await response.json());
      return parsed.success ? ok(parsed.data) : err('INVALID_RESPONSE', 'Invalid LANraragi response', false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'LANraragi request failed';
      return err('REMOTE_UNAVAILABLE', message, true);
    }
  }

  async getArchiveMetadata(archiveId: string, signal?: AbortSignal): Promise<CommandResult<ArchiveMetadata>> {
    try {
      const init: RequestInit = { headers: this.authenticationHeaders() };
      if (signal) init.signal = signal;
      const response = await this.fetcher(`${this.baseUrl}/api/archives/${encodeURIComponent(archiveId)}/metadata`, init);
      if (!response.ok) return this.httpError(response.status);
      const parsed = ArchiveMetadataSchema.safeParse(await response.json());
      return parsed.success ? ok(mapArchiveMetadata(parsed.data)) : err('INVALID_RESPONSE', 'Invalid LANraragi archive metadata', false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'LANraragi request failed';
      return err('REMOTE_UNAVAILABLE', message, true);
    }
  }

  async getArchivePage(archiveId: string, path: string, signal?: AbortSignal): Promise<CommandResult<ArrayBuffer>> {
    const query = new URLSearchParams({ path });
    try {
      const init: RequestInit = { headers: this.authenticationHeaders() };
      if (signal) init.signal = signal;
      const response = await this.fetcher(`${this.baseUrl}/api/archives/${encodeURIComponent(archiveId)}/page?${query}`, init);
      if (!response.ok) return this.httpError(response.status);
      return ok(await response.arrayBuffer());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'LANraragi request failed';
      return err('REMOTE_UNAVAILABLE', message, true);
    }
  }

  async getArchiveFiles(archiveId: string, force = false, signal?: AbortSignal): Promise<CommandResult<string[]>> {
    const query = force ? '?force=true' : '';
    try {
      const init: RequestInit = { headers: this.authenticationHeaders() };
      if (signal) init.signal = signal;
      const response = await this.fetcher(`${this.baseUrl}/api/archives/${encodeURIComponent(archiveId)}/files${query}`, init);
      if (!response.ok) return this.httpError(response.status);
      const parsed = ArchiveFilesResponseSchema.safeParse(await response.json());
      return parsed.success ? ok(parsed.data.pages) : err('INVALID_RESPONSE', 'Invalid LANraragi file list', false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'LANraragi request failed';
      return err('REMOTE_UNAVAILABLE', message, true);
    }
  }

  async searchArchives(request: SearchArchivesRequest, signal?: AbortSignal): Promise<CommandResult<SearchArchivesResponse>> {
    const query = new URLSearchParams();
    if (request.category !== undefined) query.set('category', request.category);
    if (request.filter !== undefined) query.set('filter', request.filter);
    if (request.start !== undefined) query.set('start', String(request.start));
    if (request.sortBy !== undefined) query.set('sortby', request.sortBy);
    if (request.order !== undefined) query.set('order', request.order);
    if (request.newOnly !== undefined) query.set('newonly', String(request.newOnly));
    if (request.untaggedOnly !== undefined) query.set('untaggedonly', String(request.untaggedOnly));
    if (request.hideCompleted !== undefined) query.set('hidecompleted', String(request.hideCompleted));
    if (request.groupByTankoubons !== undefined) query.set('groupby_tanks', String(request.groupByTankoubons));
    const suffix = query.size > 0 ? `?${query}` : '';

    try {
      const init: RequestInit = { headers: this.authenticationHeaders() };
      if (signal) init.signal = signal;
      const response = await this.fetcher(`${this.baseUrl}/api/search${suffix}`, init);
      if (response.status === 204) return err('REMOTE_UNAVAILABLE', 'LANraragi search index is not ready', true);
      if (!response.ok) return this.httpError(response.status);
      const parsed = SearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) return err('INVALID_RESPONSE', 'Invalid LANraragi search response', false);
      return ok({
        recordsFiltered: parsed.data.recordsFiltered,
        recordsTotal: parsed.data.recordsTotal,
        data: parsed.data.data.map(mapArchiveMetadata),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'LANraragi request failed';
      return err('REMOTE_UNAVAILABLE', message, true);
    }
  }

  private authenticationHeaders(): HeadersInit {
    return this.apiKey ? { Authorization: `Bearer ${encodeBase64(this.apiKey)}` } : {};
  }

  private httpError(status: number): CommandResult<never> {
    if (status === 401) return err('LRR_UNAUTHORIZED', 'LANraragi authentication failed', false);
    if (status === 404) return err('LRR_NOT_FOUND', 'LANraragi resource not found', false);
    if (status === 409) return err('REMOTE_CONFLICT', 'LANraragi resource conflict', true);
    if (status === 429) return err('REMOTE_RATE_LIMIT', 'LANraragi rate limit reached', true);
    return err('REMOTE_UNAVAILABLE', `LANraragi request failed (${status})`, status >= 500);
  }
}

function mapArchiveMetadata(archive: z.infer<typeof ArchiveMetadataSchema>): ArchiveMetadata {
  return {
    archiveId: archive.arcid,
    title: archive.title,
    filename: archive.filename,
    tags: archive.tags,
    ...(archive.summary === undefined || archive.summary === null ? {} : { summary: archive.summary }),
    extension: archive.extension,
    progress: archive.progress,
    pageCount: archive.pagecount,
    lastReadTime: archive.lastreadtime,
    size: archive.size,
  };
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
