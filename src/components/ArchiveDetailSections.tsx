import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { OverlayLayer } from './OverlayLayer';

import { myTagChipStyle, normalizeMyTagKey, prioritizeByMyTags } from '../lib/ehMyTags';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { usePageActive } from '../app/RetainedPage';
import { isWideCoverRatio } from '../lib/archiveCardPresentation';
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
    setCover(undefined);
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
  const pageActive = usePageActive();
  const [preview, setPreview] = useState<'closed' | 'open' | 'closing'>('closed');
  const [coverShape, setCoverShape] = useState<{ url: string; wide: boolean }>();
  const triggerImage = useRef<HTMLImageElement>(null);
  const previewImage = useRef<HTMLImageElement>(null);
  const animation = useRef<Animation>();
  const previewOpen = preview === 'open';
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const close = () => setPreview(reducedMotion ? 'closed' : 'closing');
  useLayoutEffect(() => { if (!pageActive) setPreview('closed'); }, [pageActive]);
  useLayoutEffect(() => { setPreview('closed'); }, [cover, title]);
  const animateCover = () => {
    const image = previewImage.current;
    const source = triggerImage.current;
    if (!image || !source || reducedMotion || !image.animate) return;
    // Read the visible position before cancelling an interrupted opening.
    const current = image.getBoundingClientRect();
    const currentClip = getComputedStyle(image).clipPath;
    animation.current?.cancel();
    const target = image.getBoundingClientRect();
    const origin = source.getBoundingClientRect();
    if (!target.width || !target.height || !origin.width || !origin.height) return;
    // The trigger uses `object-fit: cover` for portrait covers. Its box is
    // therefore smaller than the visible source image in one axis. Scaling X
    // and Y independently squeezed the full preview into that cropped box.
    // Scale uniformly and animate a clip matching the trigger's visible crop.
    const transform = (rect: DOMRect) => {
      const scale = Math.max(rect.width / target.width, rect.height / target.height);
      return `translate(${rect.left + rect.width / 2 - target.left - target.width / 2}px, ${rect.top + rect.height / 2 - target.top - target.height / 2}px) scale(${scale}, ${scale})`;
    };
    const originScale = Math.max(origin.width / target.width, origin.height / target.height);
    const cropX = Math.max(0, (target.width - origin.width / originScale) / 2);
    const cropY = Math.max(0, (target.height - origin.height / originScale) / 2);
    // clip-path creates the visible edge on cropped covers, so its rounding
    // must also match the thumbnail. Compensate for the uniform scale: 12px
    // corners on a quarter-size thumbnail need a 48px radius before scaling.
    const originRadius = (parseFloat(getComputedStyle(source).borderTopLeftRadius) || 0) / originScale;
    const previewRadius = parseFloat(getComputedStyle(image).borderTopLeftRadius) || 0;
    const originClip = `inset(${cropY}px ${cropX}px round ${originRadius}px)`;
    const fullClip = `inset(0px 0px round ${previewRadius}px)`;
    animation.current = image.animate(
      preview === 'closing'
        ? [{ transform: transform(current), clipPath: currentClip && currentClip !== 'none' ? currentClip : fullClip }, { transform: transform(origin), clipPath: originClip }]
        : [{ transform: transform(origin), clipPath: originClip }, { transform: 'none', clipPath: fullClip }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
  };
  useLayoutEffect(() => {
    if (preview !== 'closed') animateCover();
    else { animation.current?.cancel(); animation.current = undefined; }
    if (preview !== 'closing') return;
    const timer = window.setTimeout(() => setPreview('closed'), 220);
    return () => window.clearTimeout(timer);
  }, [preview]);
  useEffect(() => () => animation.current?.cancel(), []);
  // 返回手势先关预览这一层（见 overlayBackGuard）。
  useOverlayBackGuard(previewOpen, close);
  return <>
    <div className={`archive-detail-route-cover${coverShape?.url === cover && coverShape?.wide ? ' is-wide' : ''}`}>
      {cover
        ? <button className="archive-detail-cover-trigger" type="button" data-preview-open={preview !== 'closed' ? '' : undefined} onClick={() => setPreview('open')} aria-label={`查看${title}大图`} title="查看大图"><img ref={triggerImage} src={cover} alt={`${title} 封面`} decoding="async" onLoad={(event) => {
          const image = event.currentTarget;
          setCoverShape({ url: cover, wide: isWideCoverRatio(image.naturalWidth / image.naturalHeight) });
        }} /></button>
        : <div className={`archive-detail-cover-placeholder${loading ? ' is-skeleton' : ''}`} aria-label={loading ? '正在加载封面' : '暂无封面'} />}
    </div>
    {preview !== 'closed' && pageActive && cover && (
      <OverlayLayer>
      <FocusScope asChild trapped loop><div className={`archive-cover-preview${preview === 'closing' ? ' is-closing' : ''}`} role="dialog" tabIndex={-1} aria-modal="true" aria-label={`${title}封面大图`} onClick={close} onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
        <img ref={previewImage} src={cover} alt={`${title} 封面大图`} decoding="async" onLoad={() => { if (!animation.current) animateCover(); }} />
      </div></FocusScope>
      </OverlayLayer>
    )}
  </>;
}

/** Fit one line before falling back to CSS ellipsis. */
export function useSingleLineTitle(title: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      for (const size of ['var(--text-lg)', 'var(--text-md)', 'var(--text-sm)']) {
        element.style.fontSize = size;
        if (element.scrollWidth <= element.clientWidth + 1) break;
      }
    };
    fit();
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (width === element.clientWidth) return;
      width = element.clientWidth;
      fit();
    });
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
