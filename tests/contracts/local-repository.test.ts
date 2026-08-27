import { describe, expect, it } from 'vitest';
import { InMemoryLibraryRepository } from '../../src/repositories/inMemoryLibraryRepository';

describe('local library repository contract', () => {
  it('isolates archives by server scope', async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.upsertServer({ id: 's1', name: 'A', baseUrl: 'https://a.test', scopeId: 'scope-a' });
    await repo.upsertServer({ id: 's2', name: 'B', baseUrl: 'https://b.test', scopeId: 'scope-b' });
    await repo.upsertArchive({ serverId: 's1', archiveId: 'same', title: 'A title', pageCount: 2 });
    await repo.upsertArchive({ serverId: 's2', archiveId: 'same', title: 'B title', pageCount: 3 });

    expect((await repo.listArchives('s1'))[0]?.title).toBe('A title');
    expect((await repo.listArchives('s2'))[0]?.title).toBe('B title');
  });

  it('upsert is idempotent and preserves local progress', async () => {
    const repo = new InMemoryLibraryRepository();
    await repo.upsertArchive({ serverId: 's1', archiveId: 'a1', title: 'Old', pageCount: 10 });
    await repo.saveProgress({ scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, pageCount: 10, layout: 'paged', direction: 'ltr' });
    await repo.upsertArchive({ serverId: 's1', archiveId: 'a1', title: 'New', pageCount: 12 });

    expect((await repo.listArchives('s1'))[0]?.title).toBe('New');
    expect((await repo.getProgress('scope-a', 'a1'))?.pageIndex).toBe(4);
    expect((await repo.listArchives('s1')).length).toBe(1);
  });

  it('enforces task state transitions', async () => {
    const repo = new InMemoryLibraryRepository();
    const task = await repo.createTask({ kind: 'download', label: 'Download A' });
    await repo.updateTask(task.id, { status: 'running', progress: 0.25 });
    await repo.updateTask(task.id, { status: 'completed', progress: 1 });
    expect((await repo.getTask(task.id))?.status).toBe('completed');
    await expect(repo.updateTask(task.id, { status: 'running' })).rejects.toThrow(/terminal/i);
  });
});
