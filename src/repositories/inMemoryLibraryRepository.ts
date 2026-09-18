import type { ArchiveRecord, ReadingProgress, ServerRecord, TaskRecord, TaskStatus } from '../domain/library';

type NewArchive = Omit<ArchiveRecord, 'updatedAt'> & { updatedAt?: string };
type NewProgress = Omit<ReadingProgress, 'updatedAt' | 'revision'>;
type NewTask = Pick<TaskRecord, 'kind' | 'label'>;

const terminal = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

export class InMemoryLibraryRepository {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly archives = new Map<string, ArchiveRecord>();
  private readonly progress = new Map<string, ReadingProgress>();
  private readonly tasks = new Map<string, TaskRecord>();

  async upsertServer(server: ServerRecord): Promise<ServerRecord> {
    this.servers.set(server.id, server);
    return server;
  }

  async upsertArchive(input: NewArchive): Promise<ArchiveRecord> {
    const key = `${input.serverId}:${input.archiveId}`;
    const existing = this.archives.get(key);
    const record: ArchiveRecord = { ...existing, ...input, updatedAt: input.updatedAt ?? new Date().toISOString() };
    this.archives.set(key, record);
    return record;
  }

  async listArchives(serverId: string): Promise<ArchiveRecord[]> {
    return [...this.archives.values()].filter((archive) => archive.serverId === serverId && !archive.isDeleted);
  }

  async saveProgress(input: NewProgress): Promise<ReadingProgress> {
    const key = `${input.scopeId}:${input.archiveId}`;
    const current = this.progress.get(key);
    const record: ReadingProgress = { ...input, updatedAt: new Date().toISOString(), revision: (current?.revision ?? 0) + 1 };
    this.progress.set(key, record);
    return record;
  }

  async getProgress(scopeId: string, archiveId: string): Promise<ReadingProgress | undefined> {
    return this.progress.get(`${scopeId}:${archiveId}`);
  }

  async createTask(input: NewTask): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = { ...input, id: crypto.randomUUID(), status: 'queued', progress: 0, cancelable: true, retryable: true, receivedBytes: 0, createdAt: now, updatedAt: now };
    this.tasks.set(task.id, task);
    return task;
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    return this.tasks.get(id);
  }

  async updateTask(id: string, update: { status?: TaskStatus; progress?: number; error?: string }): Promise<TaskRecord> {
    const current = this.tasks.get(id);
    if (!current) throw new Error('Task not found');
    if (terminal.has(current.status)) throw new Error('Task is terminal');
    if (update.progress !== undefined && (update.progress < 0 || update.progress > 1)) throw new Error('Progress must be between 0 and 1');
    const task = { ...current, ...update, updatedAt: new Date().toISOString() };
    this.tasks.set(id, task);
    return task;
  }
}
