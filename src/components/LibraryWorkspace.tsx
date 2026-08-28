import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, FolderHeart, ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import type { ArchiveRecord } from '../domain/library';
import { filterArchivesByQuery, sortArchivesByTitle } from '../domain/reader';
import type { ArchiveMetadata, Category } from '../repositories/nativeLibraryRepository';
import { EmptyState } from './EmptyState';

interface LibraryWorkspaceProps {
  archives: ArchiveRecord[];
  metadata?: ArchiveMetadata | undefined;
  metadataLoading?: boolean | undefined;
  onSelect?: ((archive: ArchiveRecord) => void) | undefined;
  onDelete?: ((archive: ArchiveRecord) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
  categories?: Category[] | undefined;
  onAddCategory?: ((categoryId: string) => void) | undefined;
  onUpdateMetadata?: ((metadata: { title: string; tags: string; summary: string }) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
  thumbnail?: string | undefined;
}

export function LibraryWorkspace({ archives, metadata, metadataLoading, onSelect, onDelete, onRefresh, refreshing, categories, onAddCategory, onUpdateMetadata, thumbnail }: LibraryWorkspaceProps) {
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState(archives[0]?.archiveId);

  const filteredArchives = useMemo(() => {
    const filtered = filterArchivesByQuery(archives, searchQuery);
    return sortArchivesByTitle(filtered, sortOrder);
  }, [archives, searchQuery, sortOrder]);

  const selected = filteredArchives.find((archive) => archive.archiveId === selectedId) ?? filteredArchives[0];
  const rows = useVirtualizer({
    count: filteredArchives.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 66,
    getItemKey: (index) => filteredArchives[index]?.archiveId ?? index,
    overscan: 6,
    initialRect: { width: 720, height: 560 },
  });

  if (archives.length === 0) {
    return (
      <div>
        <LibraryHeading count={0} onRefresh={onRefresh} refreshing={refreshing} />
        <EmptyState icon={FolderHeart} title="暂无档案库" description="连接服务器后，档案会显示在这里。" />
      </div>
    );
  }

  return (
    <div className="library-workspace">
      <LibraryHeading count={filteredArchives.length} onRefresh={onRefresh} refreshing={refreshing} />
      <div className="library-controls">
        <label className="search-label">
          <span className="sr-only">搜索档案</span>
          <input
            aria-label="搜索档案"
            name="archiveQuery"
            type="search"
            autoComplete="off"
            placeholder="搜索档案…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <button
          className="secondary-action"
          type="button"
          aria-label={sortOrder === 'asc' ? '按标题降序' : '按标题升序'}
          onClick={() => setSortOrder((current) => current === 'asc' ? 'desc' : 'asc')}
        >
          {sortOrder === 'asc' ? <ArrowDownAZ aria-hidden="true" /> : <ArrowUpAZ aria-hidden="true" />}
        </button>
      </div>
      <Group className="library-panels" orientation="horizontal">
        <Panel defaultSize="64" minSize="40">
          <div className="archive-list" ref={scrollRef} role="list" aria-label="档案">
            <div className="archive-list-inner" style={{ height: rows.getTotalSize() }}>
              {rows.getVirtualItems().map((row) => {
                const archive = filteredArchives[row.index];
                if (!archive) return null;
                return (
                  <div
                    className="archive-row-wrap"
                    key={archive.archiveId}
                    role="listitem"
                    style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                  >
                    <button
                      aria-pressed={archive.archiveId === selected?.archiveId}
                      className="archive-row"
                      onClick={() => {
                        setSelectedId(archive.archiveId);
                        onSelect?.(archive);
                      }}
                      type="button"
                    >
                      <span>
                        <strong>{archive.title}</strong>
                        <small>{archive.pageCount} 页</small>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>
        <Separator className="panel-separator" />
        <Panel defaultSize="36" minSize="24">
          {selected && (
            <section className="archive-detail" aria-labelledby="archive-detail-title">
              <p className="eyebrow">档案详情</p>
              <h2 id="archive-detail-title">{selected.title}</h2>
              {thumbnail && <img className="archive-cover" src={thumbnail} alt={`${selected.title} 封面`} width="320" height="450" loading="lazy" />}
              {metadata && metadata.archiveId === selected.archiveId && onUpdateMetadata && !editingMetadata && (
                <button className="secondary-action" type="button" onClick={() => {
                  setEditingMetadata(true);
                }}>编辑元数据</button>
              )}
              {metadata && metadata.archiveId === selected.archiveId && onUpdateMetadata && editingMetadata && (
                <form className="metadata-form" onSubmit={(event) => {
                  event.preventDefault();
                  const controls = event.currentTarget.elements;
                  setSavingMetadata(true);
                  void onUpdateMetadata({
                    title: (controls.namedItem('title') as HTMLInputElement).value,
                    tags: (controls.namedItem('tags') as HTMLInputElement).value,
                    summary: (controls.namedItem('summary') as HTMLTextAreaElement).value,
                  }).then((result) => {
                    setSavingMetadata(false);
                    if (result.ok) setEditingMetadata(false);
                  });
                }}>
                  <label>标题<input name="title" aria-label="标题" autoComplete="off" defaultValue={metadata.title || selected.title} /></label>
                  <label>标签<input name="tags" aria-label="标签" autoComplete="off" spellCheck={false} defaultValue={metadata.tags} /></label>
                  <label>简介<textarea name="summary" aria-label="简介" defaultValue={metadata.summary ?? ''} /></label>
                  <button className="primary-action" type="submit" disabled={savingMetadata} aria-busy={savingMetadata}>{savingMetadata ? '保存中…' : '保存元数据'}</button>
                </form>
              )}
              {categories && onAddCategory && (
                <div className="category-controls">
                  <label>分类
                    <select name="category" aria-label="分类" value={selectedCategoryId} onChange={(event) => setSelectedCategoryId(event.target.value)}>
                      <option value="">选择分类</option>
                      {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                  </label>
                  <button className="secondary-action" type="button" disabled={!selectedCategoryId} onClick={() => onAddCategory(selectedCategoryId)}>加入分类</button>
                </div>
              )}
              {onDelete && (
                <Dialog.Root>
                  <Dialog.Trigger asChild><button className="secondary-action" type="button">删除档案</button></Dialog.Trigger>
                  <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                      <Dialog.Title>确认删除</Dialog.Title>
                      <Dialog.Description>将从 LANraragi 删除“{selected.title}”，此操作不可撤销。</Dialog.Description>
                      <div className="dialog-actions">
                        <Dialog.Close asChild><button className="secondary-action" type="button">取消</button></Dialog.Close>
                        <Dialog.Close asChild>
                          <button className="primary-action" type="button" onClick={() => void onDelete(selected)}>确认删除</button>
                        </Dialog.Close>
                      </div>
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog.Root>
              )}
              <dl>
                <div><dt>页数</dt><dd>{selected.pageCount}</dd></div>
                <div><dt>服务器</dt><dd>{selected.serverId}</dd></div>
                {metadataLoading && <div><dt>元数据</dt><dd>加载中…</dd></div>}
                {metadata && metadata.archiveId === selected.archiveId && (
                  <>
                    <div><dt>文件名</dt><dd>{metadata.filename}</dd></div>
                    <div><dt>格式</dt><dd>{metadata.extension}</dd></div>
                    {metadata.summary && <div><dt>简介</dt><dd>{metadata.summary}</dd></div>}
                  </>
                )}
              </dl>
            </section>
          )}
        </Panel>
      </Group>
    </div>
  );
}

function LibraryHeading({ count, onRefresh, refreshing }: { count: number; onRefresh?: (() => void) | undefined; refreshing?: boolean | undefined }) {
  return (
    <header className="workspace-heading library-heading">
      <div>
        <p className="workspace-kicker">本地索引</p>
        <h1>档案库</h1>
      </div>
      <span className="library-heading-actions">
        <span>{count} 项</span>
        {onRefresh && (
          <button
            className="secondary-action"
            type="button"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? '刷新中…' : '刷新档案库'}
          </button>
        )}
      </span>
    </header>
  );
}
