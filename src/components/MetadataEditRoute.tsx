import { ArrowLeft, BookOpen, LoaderCircle, Play, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { parseArchiveTagString } from '../lib/tags';
import { invalidateRouteCache } from '../lib/routeCache';
import { useTagTranslations } from '../lib/tagTranslationService';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { MetadataTagChip } from './MetadataTagChip';
import { TagSuggest } from './TagSuggest';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();

export function MetadataEditRoute({ archiveId }: { archiveId: string }) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  useTagTranslations();
  const [serverId, setServerId] = useState<string>();
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState('');
  const [plugin, setPlugin] = useState('');
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'plugin' | 'delete' | ''>('');
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  // Both reach the toast as well as the page. This panel is embedded in settings,
  // where every neighbouring control reports that way, and an error rendered only
  // at the bottom of a scrolled panel is an error nobody sees.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);
  useEffect(() => {
    if (message) showToast(message, 'success');
  }, [message, showToast]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const servers = await repository.listServers();
      const server = servers.ok ? servers.value[0] : undefined;
      if (!active) return;
      if (!server) { setError(servers.ok ? '尚未配置服务器' : servers.error.message); setLoading(false); return; }
      setServerId(server.id);
      const [metadata, pluginResult] = await Promise.all([
        repository.loadArchiveMetadata(server.id, archiveId),
        repository.listMetadataPlugins(server.id),
      ]);
      if (!active) return;
      if (metadata.ok) {
        setTitle(metadata.value.title);
        setTags(metadata.value.tags);
        setSummary(metadata.value.summary ?? '');
      } else setError(metadata.error.message);
      if (pluginResult.ok) {
        const pluginSource = Array.isArray(pluginResult.value) ? pluginResult.value : (pluginResult.value && typeof pluginResult.value === 'object' && Array.isArray((pluginResult.value as { data?: unknown }).data) ? (pluginResult.value as { data: unknown[] }).data : []);
        const normalized = pluginSource.flatMap((item, index) => {
          if (typeof item === 'string') return [{ id: item, name: item }];
          if (!item || typeof item !== 'object') return [];
          const value = String(item.plugin_id ?? item.id ?? item.namespace ?? item.name ?? `plugin-${index}`);
          return [{ id: value, name: String(item.name ?? value) }];
        });
        setPlugins(normalized);
        setPlugin(normalized[0]?.id ?? '');
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [archiveId]);

  const tagList = useMemo(() => parseArchiveTagString(tags), [tags]);
  const setTagList = (next: readonly string[]) => {
    // The stored value stays the LANraragi tag string, because that is what the
    // API takes; the chips are a view of it rather than a parallel model.
    const unique: string[] = [];
    for (const tag of next) {
      const trimmed = tag.trim();
      if (trimmed && !unique.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) unique.push(trimmed);
    }
    setTags(unique.join(', '));
  };
  const commitTagDraft = (raw: string) => {
    const additions = parseArchiveTagString(raw);
    if (additions.length === 0) return;
    setTagList([...tagList, ...additions]);
    setTagDraft('');
  };
  const save = async () => {
    if (!serverId || busy) return;
    setBusy('save'); setError(undefined);
    const result = await repository.updateArchiveMetadata(serverId, archiveId, { title, tags, summary });
    if (result.ok) {
      setMessage('元数据已更新');
      // The detail page paints from a snapshot of this metadata, and the
      // recommendation rail is keyed on these tags. Both are wrong now.
      invalidateRouteCache('archive-detail:');
      invalidateRouteCache('recommendations:');
    } else setError(result.error.message);
    setBusy('');
  };
  const runPlugin = async () => {
    if (!plugin || busy) return;
    setBusy('plugin'); setError(undefined);
    if (!serverId) return;
    const result = await repository.useMetadataPlugin(serverId, archiveId, plugin, title);
    if (result.ok) {
      const data = result.value?.data && typeof result.value.data === 'object' ? result.value.data : result.value;
      if (data && typeof data === 'object') {
        const fields = data as { title?: unknown; tags?: unknown; summary?: unknown };
        if (typeof fields.title === 'string') setTitle(fields.title);
        if (typeof fields.tags === 'string') setTags(fields.tags);
        if (typeof fields.summary === 'string') setSummary(fields.summary);
      }
      setMessage('插件结果已载入，保存后生效');
    } else setError(result.error.message);
    setBusy('');
  };
  const deleteArchive = async () => {
    if (!serverId || busy) return;
    if (!window.confirm('确认删除此档案？此操作不可撤销。')) return;
    setBusy('delete');
    const result = await repository.deleteArchive(serverId, archiveId);
    if (result.ok) {
      // Every cached view of this archive is now a card that leads nowhere.
      invalidateRouteCache('archive-detail:');
      invalidateRouteCache('recommendations:');
      navigate('/library');
    } else setError(result.error.message);
    setBusy('');
  };

  if (loading) return <main className="metadata-edit-page metadata-edit-loading"><LoaderCircle className="spin" aria-hidden="true" /><span>正在载入元数据…</span></main>;
  if (error && !serverId) return <main className="metadata-edit-page"><p className="form-error" role="alert">{error}</p><Link className="secondary-action" to={`/library/${archiveId}`}><ArrowLeft aria-hidden="true" />返回详情</Link></main>;
  return (
    <main className="metadata-edit-page" aria-labelledby="metadata-edit-title">
      <header className="metadata-edit-header">
        <Link className="reader-icon-button" to={`/library/${archiveId}`} aria-label="返回详情"><ArrowLeft aria-hidden="true" /></Link>
        <h1 id="metadata-edit-title">编辑元数据</h1>
      </header>
      <form className="metadata-edit-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {/* One list, not two. There used to be a raw comma-separated textarea and
            a read-only run of translated chips underneath it: nothing tied them
            together, so the translations were decoration and every edit was
            string surgery. Each chip shows the translation, reveals the original,
            and carries its own delete. */}
        <div className="metadata-tag-field">
          <span className="metadata-tag-field-label" id="metadata-tags-label">标签</span>
          <div className="metadata-tags-box" role="group" aria-labelledby="metadata-tags-label">
            {tagList.map((tag) => (
              <MetadataTagChip key={tag} tag={tag} onDelete={() => setTagList(tagList.filter((item) => item !== tag))} />
            ))}
            {tagList.length === 0 && <span className="metadata-tags-empty">还没有标签</span>}
          </div>
          <label className="metadata-tag-input">
            <input
              ref={tagInputRef}
              aria-label="添加标签"
              placeholder="输入标签后回车，例如 artist:someone"
              value={tagDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commitTagDraft(tagDraft); }
                else if (event.key === 'Backspace' && !tagDraft && tagList.length > 0) {
                  setTagList(tagList.slice(0, -1));
                }
              }}
            />
            {/* Same suggestion list the library search uses, so a namespace does
                not have to be typed from memory. */}
            <TagSuggest inputValue={tagDraft} anchorRef={tagInputRef} onSelect={(tag) => commitTagDraft(tag)} />
          </label>
        </div>
        <label>简介<textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={8} /></label>
        {plugins.length > 0 && <div className="metadata-plugin-row"><select aria-label="元数据插件" value={plugin} onChange={(event) => setPlugin(event.target.value)}>{plugins.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="secondary-action" type="button" disabled={!!busy} onClick={() => void runPlugin()}><Play aria-hidden="true" />执行插件</button></div>}
      {/* Same as the sync panel: a save landing or failing is an event, and the
          toast is where events are reported. */}
        <div className="metadata-edit-actions">
          <button className="primary-action" type="submit" aria-label="保存元数据" disabled={!!busy}><Save aria-hidden="true" />{busy === 'save' ? '保存中…' : '保存元数据'}</button>
          <Link className="secondary-action" to={`/reader/${archiveId}`}><BookOpen aria-hidden="true" />阅读</Link>
          <button className="secondary-action" type="button" disabled={!!busy} onClick={() => void deleteArchive()}><Trash2 aria-hidden="true" />删除</button>
        </div>
      </form>
    </main>
  );
}
