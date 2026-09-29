import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { myTagChipStyle, normalizeMyTagKey, prioritizeByMyTags } from '../lib/ehMyTags';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { getNativeImageCache } from '../lib/nativeImageCache';
import { categorizeSearchableTags, type SearchableTagGroup } from '../lib/tags';
import { TagSearchLink } from './TagSearchLink';
import { useEhMyTags } from './useEhMyTags';

/** 详情页上「这份档案是什么」的几块：标题、封面、事实网格、标签分组。档案详情
 * （/library/:id）和本地档案的详情面板渲染的是同一批组件、同一批类名，两边的长相
 * 和标签顺序就不可能各自漂移——本地档案页自己写一套 `<dl>` 和一行扁平的标签，正是
 * 「详情页没有复用」的来源。 */

export type DetailFactKind = 'pages' | 'size' | 'category' | 'added' | 'published' | 'path';

export interface DetailFact {
  kind: DetailFactKind;
  label: string;
  value: string;
}

/** `date_added:` / `timestamp:` 里的时间戳，写成日期时间。 */
export function detailTagTime(tags: readonly string[], namespace: string): string {
  const tag = tags.find((value) => value.split(':', 1)[0]?.trim().toLowerCase() === namespace);
  const raw = tag?.slice(tag.indexOf(':') + 1).trim();
  if (!raw) return '未知';
  const numeric = Number(raw);
  const date = new Date(Number.isFinite(numeric) ? numeric * (numeric > 1e12 ? 1 : 1000) : raw);
  if (Number.isNaN(date.getTime()) || (Number.isFinite(numeric) && numeric <= 0)) return '未知';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DetailFactGlyph({ kind }: { kind: DetailFactKind }) {
  const paths: Record<DetailFactKind, string> = {
    pages: 'M7 2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 2v12h10V4H7ZM3 6v14h12v2H3a2 2 0 0 1-2-2V6h2Z',
    size: 'M4 3h16a2 2 0 0 1 2 2v4H2V5a2 2 0 0 1 2-2Zm0 2v2h16V5H4ZM3 11h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Zm2 2v7h14v-7H5Zm4 1h6v2H9v-2Z',
    category: 'M4 4h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v2h18V8H4Zm0 4v8h18v-8H4Z',
    added: 'M7 1h2v2h6V1h2v2h3a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3V1ZM4 5v3h16V5H4Zm0 5v10h16V10H4Zm7 1h2v3h3v2h-3v3h-2v-3H8v-2h3v-3Z',
    published: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-1 2h2v5.6l3.7 2.2-1 1.7-4.7-2.8V6Z',
    // 本地档案那一格写的是磁盘上的位置，用一块盘而不是文件夹：文件夹在这个网格里
    // 已经是「分类」了。
    path: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v3h16V6H4Zm0 5v7h16v-7H4Zm3 1.5h4v2H7v-2Z',
  };
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

export function ArchiveDetailFacts({ facts, loading = false }: { facts: readonly DetailFact[]; loading?: boolean }) {
  return <dl className="archive-detail-facts" aria-label="档案信息">
    {facts.map(({ kind, label, value }) => (
      <div key={kind} data-fact={kind} title={label}>
        <dt aria-label={label}><DetailFactGlyph kind={kind} /><span className="visually-hidden">{label}</span></dt>
        <dd>{loading ? <span className="skeleton-line" /> : value}</dd>
      </div>
    ))}
  </dl>;
}

/** 从原生图片缓存取封面。本地档案只有在认出服务器上的那一份之后才取得到，所以
 * `enabled` 是开关：没有 scope 时不发请求，停在占位图上。 */
export function useArchiveCover({ scopeId, serverId, archiveId, enabled = true }: {
  scopeId?: string | undefined;
  serverId?: string | undefined;
  archiveId?: string | undefined;
  enabled?: boolean | undefined;
}) {
  const [cover, setCover] = useState<string>();
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled || !scopeId || !serverId || !archiveId) {
      setCover(undefined);
      setLoading(false);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    let handle: import('../lib/unifiedImageCache').ImageHandle | undefined;
    setLoading(true);
    void getNativeImageCache().load({ scopeId, serverId, archiveId, rendition: 'cover', pageIndex: 0 }, { signal: controller.signal })
      .then((value) => {
        if (!active) { getNativeImageCache().release(value); return; }
        handle = value;
        setCover(value.url);
      })
      .catch(() => undefined)
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      controller.abort();
      if (handle) getNativeImageCache().release(handle);
    };
  }, [archiveId, enabled, scopeId, serverId]);
  return { cover, loading };
}

/** 封面那一格，点开是全屏大图。预览覆盖层跟着它一起走（Esc 也归它关），调用方
 * 不用再管。 */
export function ArchiveDetailCover({ title, cover, loading = false }: { title: string; cover?: string | undefined; loading?: boolean }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  // 返回手势先关预览这一层（见 overlayBackGuard）。
  useOverlayBackGuard(previewOpen, () => setPreviewOpen(false));
  useEffect(() => {
    if (!previewOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewOpen]);
  return <>
    <div className="archive-detail-route-cover">
      {cover
        ? <button className="archive-detail-cover-trigger" type="button" onClick={() => setPreviewOpen(true)} aria-label={`查看${title}大图`} title="查看大图"><img src={cover} alt={`${title} 封面`} decoding="async" /></button>
        : <div className={`archive-detail-cover-placeholder${loading ? ' is-skeleton' : ''}`} aria-label={loading ? '正在加载封面' : '暂无封面'} />}
    </div>
    {previewOpen && cover && (
      <div className="archive-cover-preview" role="dialog" aria-modal="true" aria-label={`${title}封面大图`} onClick={() => setPreviewOpen(false)}>
        <img src={cover} alt={`${title} 封面大图`} decoding="async" />
      </div>
    )}
  </>;
}

/** 标题最多两行：撑不下就一档一档降字号，最小的那档还溢出才交给 CSS 的省略号。 */
export function useTwoLineTitle(title: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const sizes = ['var(--text-lg)', 'var(--text-md)', 'var(--text-sm)'];
    const fit = () => {
      // The stylesheet clamps the element to two lines, which pins scrollHeight
      // to the clamped height — lift it for the measurement, restore after.
      const previousDisplay = element.style.display;
      element.style.display = 'block';
      let step = 0;
      element.style.fontSize = sizes[0]!;
      while (step < sizes.length - 1) {
        const style = window.getComputedStyle(element);
        // line-height resolves to px already (1.4 × font-size); the two-line
        // budget is just that height doubled.
        const lineHeight = style.lineHeight === 'normal' ? parseFloat(style.fontSize) * 1.4 : parseFloat(style.lineHeight);
        if (element.scrollHeight <= lineHeight * 2 + 2) break;
        step += 1;
        element.style.fontSize = sizes[step]!;
      }
      element.style.display = previousDisplay;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => fit());
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [title]);
  return ref;
}

/** 详情页的标签墙：My Tags 先排序、再按命名空间分组。档案详情与本地档案详情共用
 * 一处推导，芯片的顺序、分组和染色才一致。 */
export function useDetailTagGroups(tags: readonly string[]) {
  const myTags = useEhMyTags();
  const groups = useMemo(() => categorizeSearchableTags(prioritizeByMyTags(tags, myTags)), [tags, myTags]);
  const colorFor = useMemo(() => (query: string) => myTags.colors.get(normalizeMyTagKey(query.replace(/\$$/, ''))), [myTags.colors]);
  return { groups, colorFor };
}

/** 标签墙本体。默认每枚芯片链到档案库的标签搜索；本地档案页传 `onSelect`，改成
 * 筛它自己的列表——芯片的长相和不属于这一页的动作是两件事。 */
export function ArchiveDetailTagSection({ groups, loading = false, colorFor, onSelect }: {
  groups: readonly SearchableTagGroup[];
  loading?: boolean;
  colorFor?: ((query: string) => string | undefined) | undefined;
  onSelect?: ((tag: { label: string; query: string }) => void) | undefined;
}) {
  return <div className="archive-detail-tag-section">
    {loading && <div className="archive-detail-copy-skeleton" aria-hidden="true"><div className="skeleton-line skeleton-line-short" /><div className="skeleton-line" /><div className="skeleton-line skeleton-line-short" /><div className="skeleton-line" /></div>}
    {groups.length > 0 && (
      <div className="archive-detail-tags" aria-label="档案标签">
        {groups.map((group) => (
          <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}>
            <h2>{group.label}</h2>
            <div className="archive-detail-tag-row">
              <span className="archive-detail-tag-values">
                {group.values.map((tag, index) => {
                  const color = colorFor?.(tag.query);
                  const key = `${group.namespace}-${tag.query}-${index}`;
                  // 颜色是账户自己的预设（任意 hex），芯片文字得跟着底色亮度走。
                  return onSelect
                    ? <button className="metadata-chip tag-search-link" type="button" key={key} aria-label={`筛选 ${tag.label}`} title={`筛选 ${tag.label}`} style={color ? myTagChipStyle(color) : undefined} onClick={() => onSelect(tag)}>{tag.label}</button>
                    : <TagSearchLink label={tag.label} query={tag.query} color={color} key={key} />;
                })}
              </span>
            </div>
          </section>
        ))}
      </div>
    )}
  </div>;
}
