import { StateIcon } from './StateIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ExternalLink, Heart, NotebookPen } from 'lucide-react';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { OverlayLayer } from './OverlayLayer';
import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection, useDetailTagGroups, useSingleLineTitle } from './ArchiveDetailSections';
import { NativeEhRepository, type EhGallery } from '../repositories/nativeEhRepository';
import { presentEhError } from '../services/ehClient';
import { openExternalUrl } from '../bridge/externalUrl';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { usePageActive } from '../app/RetainedPage';
import { useDetailZoom } from '../lib/useDetailZoom';
import { SettingsMenu } from './SettingsValueControls';
import { StatusLine } from './StatusLine';
import { useToast } from './Toast';
import { EhComments } from './EhComments';
import { usePanelPager } from '../lib/usePanelPager';
import { categoryTagLabel } from '../lib/tags';
import { createGalleryImageLoader, EhGalleryThumbnail, useGalleryImage, useGalleryThumbnails } from './EhGalleryMedia';
import { DetailPageThumbnail, DETAIL_THUMBNAIL_FOOTER, DETAIL_THUMBNAIL_WIDTH } from './DetailPageThumbnail';
import { VirtualPageGrid } from './VirtualPageGrid';
import '../styles/detail-pager.css';

const repository = new NativeEhRepository();
const PANELS = ['details', 'comments'] as const;

/** A remote gallery uses the archive detail's visual components, without
 * pretending it is a LANraragi archive or offering unavailable local actions. */
export function EhGalleryDetail({ accountId, galleryId, token, onClose }: { accountId: string; galleryId: string; token: string; onClose: () => void }) {
  const active = usePageActive();
  const { surface, close } = useDetailZoom(onClose);
  const { showToast } = useToast();
  const [gallery, setGallery] = useState<EhGallery>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const images = useMemo(() => createGalleryImageLoader(accountId), [accountId, galleryId, token]);
  useEffect(() => { images.activate(); return () => images.dispose(); }, [images]);
  const cover = useGalleryImage(gallery?.cover, images);
  const [favoriteOpen, setFavoriteOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [panel, setPanel] = useState<typeof PANELS[number]>('details');
  const pager = usePanelPager({ order: PANELS, panel, enabled: active, onChange: setPanel, resetKey: `${accountId}:${galleryId}:${token}` });
  const title = gallery?.title ?? '画廊详情';
  const titleRef = useSingleLineTitle(title);
  const { groups, colorFor } = useDetailTagGroups(gallery?.tags ?? []);
  const [host, setHost] = useState('e-hentai.org');
  const thumbnails = useGalleryThumbnails(gallery, accountId, galleryId, token);
  useOverlayBackGuard(active, close);
  useEffect(() => { if (!active) onClose(); }, [active, onClose]);
  useEffect(() => {
    let alive = true;
    setError(undefined);
    setLoading(true);
    void repository.listAccounts().then(result => {
      if (alive && result.ok) setHost(result.value.find(account => account.id === accountId)?.host ?? 'e-hentai.org');
    });
    void repository.getGallery(accountId, galleryId, token).then(result => {
      if (!alive) return;
      setLoading(false);
      if (result.ok) { setGallery(result.value); setNote(result.value.favoriteNote); }
      else setError(presentEhError(result.error.code, result.error.message));
    });
    return () => { alive = false; };
  }, [accountId, galleryId, token, reload]);
  const mutateFavorite = async (category: number, noteOnly = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const remove = !noteOnly && gallery?.favoriteCategory === category;
    try {
      const result = remove ? await repository.removeFavorite(accountId, galleryId, token)
        : await repository.setGalleryFavorite(accountId, galleryId, token, category, note);
      if (!result.ok) { showToast(presentEhError(result.error.code, result.error.message), 'error'); return; }
      setGallery(current => current ? { ...current, favoriteCategory: remove ? null : category, favoriteNote: remove ? '' : note } : current);
      setFavoriteOpen(false);
      showToast(remove ? '已取消 EH 收藏' : '已保存 EH 收藏', 'success');
    } finally { pending.current = false; setBusy(false); }
  };
  return <OverlayLayer><FocusScope asChild trapped={!favoriteOpen} loop>
    <div ref={surface} className="eh-gallery-detail-overlay" role="dialog" aria-modal="true" aria-label="画廊详情" tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape' && !favoriteOpen) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <main className="archive-detail-route eh-gallery-detail">
        <header className="archive-detail-route-header">
          <button type="button" className="reader-icon-button" aria-label="返回评论" onClick={close}><ArrowLeft /></button>
          <h1 ref={titleRef} className="archive-detail-route-title">{title}</h1>
        </header>
        {error && <><StatusLine tone="error">{error}</StatusLine><button className="secondary-action" onClick={() => setReload(value => value + 1)}>重试</button></>}
        <div className="archive-detail-overview">
          <div className="eh-gallery-cover"><ArchiveDetailCover title={title} cover={cover.image} loading={(!gallery && !error) || Boolean(gallery?.cover && !cover.image && !cover.error)} />
            {cover.error && <button type="button" className="secondary-action" onClick={cover.retry}>重试封面</button>}</div>
          <div className="archive-detail-overview-copy"><ArchiveDetailFacts loading={!gallery} facts={[
            { kind: 'pages', label: '页数', value: `${gallery?.pageCount ?? 0} 页` },
            { kind: 'size', label: '体积', value: gallery?.size ?? '' },
            { kind: 'category', label: '分类', value: categoryTagLabel(gallery?.category ?? '') },
            { kind: 'published', label: '发布时间', value: gallery?.posted ?? '' },
          ]} /></div>
        </div>
        <div className="archive-detail-route-actions" role="toolbar" aria-label="画廊操作">
          <button className="secondary-action" disabled={!gallery || busy} aria-pressed={gallery?.favoriteCategory != null} onClick={() => { setNote(gallery?.favoriteNote ?? ''); setNoteOpen(false); setFavoriteOpen(true); }}><StateIcon name="heart" selected={gallery?.favoriteCategory != null} /><span>收藏</span></button>
          <button className="secondary-action" onClick={() => { void openExternalUrl(`https://${host}/g/${galleryId}/${token}/`).then(result => { if (!result.ok) showToast(result.error.message, 'error'); }); }}><ExternalLink /><span>跳转画廊</span></button>
        </div>
        <div className="archive-detail-panel-tabs" role="tablist" aria-label="画廊内容">
          {PANELS.map(id => <button key={id} type="button" role="tab" aria-selected={pager.selectedPanel === id} className={pager.selectedPanel === id ? 'is-active' : ''} onClick={() => pager.goTo(id)}><StateIcon name={id === 'details' ? 'image' : 'comments'} selected={pager.selectedPanel === id} />{id === 'details' ? '详情' : '评论'}</button>)}
        </div>
        <div ref={pager.containerRef} className={pager.containerClass}>
          <div role="tabpanel" aria-label="画廊详情" {...pager.panelProps('details')}><ArchiveDetailTagSection groups={groups} colorFor={colorFor} loading={!gallery && !error} />
            {gallery && gallery.thumbnails.length > 0 && <section className="archive-page-thumbnails" aria-label="画廊缩略图" aria-busy={loading}>
              <VirtualPageGrid count={gallery.pageCount} className="archive-page-thumbnails-grid" minWidth={DETAIL_THUMBNAIL_WIDTH} footerHeight={DETAIL_THUMBNAIL_FOOTER} onRangeChange={thumbnails.loadRange}>
                {index => { const thumbnail = thumbnails.items.get(index + 1); return thumbnail
                  ? <EhGalleryThumbnail key={index} thumbnail={thumbnail} loader={images} sprite={thumbnails.sprites.has(thumbnail.url)} />
                  : <DetailPageThumbnail key={index} page={index + 1} loading><span /></DetailPageThumbnail>; }}
              </VirtualPageGrid>
              {thumbnails.error && <><StatusLine tone="error">{thumbnails.error}</StatusLine><button type="button" className="secondary-action" onClick={thumbnails.retry}>重试缩略图</button></>}
            </section>}
          </div>
          <div role="tabpanel" aria-label="画廊评论" {...pager.panelProps('comments')}><EhComments accountId={accountId} galleryId={galleryId} token={token} /></div>
        </div>
      </main>
      {favoriteOpen && gallery && <SettingsMenu title="选择收藏夹" icon={<Heart />} onClose={() => { if (!pending.current) setFavoriteOpen(false); }}>
        <div className="eh-favorite-categories" role="group" aria-label="收藏分类" aria-busy={busy}>
          {gallery.favoriteCategories.map((label, index) => <button type="button" className="eh-favorite-category" key={index} disabled={busy} aria-pressed={gallery.favoriteCategory === index} onClick={() => void mutateFavorite(index)}>{label}</button>)}
        </div>
        <div className={`eh-favorite-note${noteOpen ? ' is-open' : ''}`}>
          <div className="eh-favorite-note-input" {...(!noteOpen ? { inert: '' } : {})} aria-hidden={!noteOpen}>
            <input type="text" aria-label="收藏备注" placeholder="收藏备注" value={note} maxLength={200} disabled={busy} onChange={event => setNote(event.target.value)} />
            {gallery.favoriteCategory != null && <button type="button" className="reader-icon-button" aria-label="保存备注" disabled={busy} onClick={() => void mutateFavorite(gallery.favoriteCategory!, true)}><Check /></button>}
          </div>
          <button type="button" className="reader-icon-button" aria-label="编辑收藏备注" aria-expanded={noteOpen} disabled={busy} onClick={() => setNoteOpen(open => !open)}><NotebookPen /></button>
        </div>
      </SettingsMenu>}
    </div>
  </FocusScope></OverlayLayer>;
}
