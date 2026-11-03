import { AutoTextarea } from './AutoTextarea';
import { ArrowLeft, BookOpen, LoaderCircle, Play, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { parseArchiveTagString, tagIdentity } from '../lib/tags';
import { pickServer } from '../domain/server';
import { invalidateRouteCache } from '../lib/routeCache';
import { useTagTranslations } from '../lib/tagTranslationService';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { MetadataTagRows } from './MetadataTagRows';
import { ArchiveDeleteDialog } from './ArchiveDeleteDialog';
import { TagSuggest } from './TagSuggest';
import { useToast } from './Toast';
import { MetadataEditorSkeleton } from './MetadataEditorSkeleton';
import { StatusLine } from './StatusLine';
import { SelectField } from './SelectField';
import { useReturnNavigation } from '../lib/useReturnNavigation';
import { metadataPluginResult } from '../lib/metadataPluginResult';

const repository = new NativeLibraryRepository();

export function MetadataEditRoute({ archiveId }: { archiveId: string }) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const goBack = useReturnNavigation();
  useTagTranslations();
  const [searchParams] = useSearchParams();
  const serverParam = searchParams.get('server');
  const [serverId, setServerId] = useState<string>();
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState('');
  const [plugin, setPlugin] = useState('');
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const [pluginReload, setPluginReload] = useState(0);
  const [pluginError, setPluginError] = useState<string>();
  const [busy, setBusy] = useState<'save' | 'plugin' | 'delete' | ''>('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const editorIdentity = `${serverParam ?? 'default'}:${archiveId}`;
  const editorOwner = useRef({ identity: editorIdentity, version: 0, busy: false });
  if (editorOwner.current.identity !== editorIdentity) editorOwner.current = { identity: editorIdentity, version: 0, busy: false };

  // 错误既进页面也进吐司：这个面板嵌在设置里，旁边的每个控件都这么报，而只写在
  // 滚动面板最下面的一行错，没人看得见。（同步设置那边同一条规矩，指向这里。）
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);
  useEffect(() => {
    if (message) showToast(message, 'success');
  }, [message, showToast]);

  useEffect(() => {
    let active = true;
    const owner = editorOwner.current;
    owner.version++;
    owner.busy = false;
    setBusy('');
    setLoading(true);
    setReady(false);
    setServerId(undefined);
    setError(undefined);
    setMessage(undefined);
    setTitle(''); setTags(''); setTagDraft(''); setSummary('');
    setDeleteOpen(false);
    void (async () => {
      const servers = await repository.listServers();
      const server = servers.ok ? pickServer(servers.value, serverParam) : undefined;
      if (!active) return;
      if (!server) { setError(servers.ok ? '尚未配置服务器' : servers.error.message); setLoading(false); return; }
      setServerId(server.id);
      const metadata = await repository.loadArchiveMetadata(server.id, archiveId);
      if (!active) return;
      if (metadata.ok) {
        setTitle(metadata.value.title);
        setTags(metadata.value.tags);
        setSummary(metadata.value.summary ?? '');
        setReady(true);
      } else setError(metadata.error.message);
      setLoading(false);
    })();
    return () => { active = false; owner.version++; };
  }, [archiveId, serverParam, reload]);

  useEffect(() => {
    let active = true;
    setPlugins([]); setPlugin(''); setPluginError(undefined);
    if (!serverId) return;
    void repository.listMetadataPlugins(serverId).then(pluginResult => {
      if (!active) return;
      if (pluginResult.ok) {
        const pluginSource = Array.isArray(pluginResult.value) ? pluginResult.value : (pluginResult.value && typeof pluginResult.value === 'object' && Array.isArray((pluginResult.value as { data?: unknown }).data) ? (pluginResult.value as { data: unknown[] }).data : []);
        const normalized = pluginSource.flatMap((item, index) => {
          if (typeof item === 'string') return [{ id: item, name: item }];
          if (!item || typeof item !== 'object') return [];
          const value = String(item.plugin_id ?? item.id ?? item.namespace ?? item.name ?? `plugin-${index}`);
          return [{ id: value, name: String(item.name ?? value) }];
        });
        setPlugins(normalized);
        const preferred = normalized.find((item) => /e[\s_-]?hentai/i.test(`${item.id} ${item.name}`));
        setPlugin(preferred?.id ?? normalized[0]?.id ?? '');
      } else setPluginError(pluginResult.error.message);
    });
    return () => { active = false; };
  }, [archiveId, serverId, pluginReload]);

  const tagList = useMemo(() => parseArchiveTagString(tags), [tags]);
  const setTagList = (next: readonly string[]) => {
    // The stored value stays the LANraragi tag string, because that is what the
    // API takes; the chips are a view of it rather than a parallel model.
    // 去重按 `tagIdentity`：`artist: somebody` 与 `artist:somebody$` 在界面上是同一枚
    // chip，两条都留下来就是用户看到的「重复标签」。
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const tag of next) {
      const trimmed = tag.trim();
      const identity = tagIdentity(trimmed);
      if (!trimmed || seen.has(identity)) continue;
      seen.add(identity);
      unique.push(trimmed);
    }
    const serialized = unique.join(', ');
    setTags(serialized);
    return serialized;
  };
  const commitTagDraft = (raw: string) => {
    const additions = parseArchiveTagString(raw);
    if (additions.length === 0) return;
    setTagList([...tagList, ...additions]);
    setTagDraft('');
  };
  const save = async () => {
    if (!serverId || !ready || editorOwner.current.busy) return;
    const owner = editorOwner.current;
    const version = owner.version;
    owner.busy = true;
    // Commit text still in the input before serializing the payload. Without
    // this, pressing Save immediately after typing a tag silently drops it.
    const pendingTags = parseArchiveTagString(tagDraft);
    const nextTags = pendingTags.length > 0
      ? setTagList([...tagList, ...pendingTags])
      : tags;
    if (pendingTags.length > 0) setTagDraft('');
    setBusy('save'); setError(undefined);
    const result = await repository.updateArchiveMetadata(serverId, archiveId, { title, tags: nextTags, summary });
    if (editorOwner.current !== owner || owner.version !== version) return;
    if (result.ok) {
      setMessage('元数据已更新');
      // The detail page paints from a snapshot of this metadata, and the
      // recommendation rail is keyed on these tags. Both are wrong now.
      invalidateRouteCache('archive-detail:');
      invalidateRouteCache('recommendations:');
    } else setError(result.error.message);
    setBusy('');
    owner.busy = false;
  };
  const runPlugin = async () => {
    if (!serverId || !ready || !plugin || editorOwner.current.busy) return;
    const owner = editorOwner.current;
    const version = owner.version;
    owner.busy = true;
    setBusy('plugin'); setError(undefined);
    // The optional one-shot argument is plugin-specific (often a gallery URL),
    // not the archive title. With no override the plugin uses archive metadata.
    const result = await repository.useMetadataPlugin(serverId, archiveId, plugin, '');
    if (editorOwner.current !== owner || owner.version !== version) return;
    if (result.ok) {
      try {
        const fields = metadataPluginResult(result.value, tags);
        if (fields.title !== undefined) setTitle(fields.title);
        if (fields.tags !== undefined) setTags(fields.tags);
        if (fields.summary !== undefined) setSummary(fields.summary);
        if (fields.changed) setMessage('插件结果已载入，保存后生效');
        else setError('插件没有返回新的元数据，请检查插件配置和档案的来源链接');
      } catch (error) { setError(error instanceof Error ? error.message : '插件执行失败'); }
    } else setError(result.error.message);
    setBusy('');
    owner.busy = false;
  };

  if (loading) return <MetadataEditorSkeleton onBack={goBack} />;
  if (error && !ready) return <main className="metadata-edit-page"><p className="form-error" role="alert">{error}</p><button className="primary-action" type="button" onClick={() => setReload(value => value + 1)}><RotateCcw aria-hidden="true" />重试载入元数据</button><button className="secondary-action" type="button" onClick={goBack}><ArrowLeft aria-hidden="true" />返回</button></main>;
  return (
    <main className="metadata-edit-page" aria-labelledby="metadata-edit-title">
      <header className="metadata-edit-header">
        <button className="reader-icon-button" type="button" onClick={goBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
        <div className="metadata-edit-heading"><h1 id="metadata-edit-title">编辑元数据</h1></div>
      </header>
      <form className="metadata-edit-form" aria-busy={Boolean(busy)} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="metadata-edit-fields" disabled={Boolean(busy)}>
        {/* 标题与简介是这里仅有的两段散文，所以只有它们要回自动大写与拼写检查。 */}
        <label>标题<input value={title} autoCapitalize="sentences" spellCheck onChange={(event) => setTitle(event.target.value)} /></label>
        {/* One list, not two. There used to be a raw comma-separated textarea and
            a read-only run of translated chips underneath it: nothing tied them
            together, so the translations were decoration and every edit was
            string surgery. Each chip shows the translation, reveals the original,
            and carries its own delete. */}
        <div className="metadata-tag-field">
          <span className="metadata-tag-field-label" id="metadata-tags-label">标签</span>
          <div className="metadata-tags-box" role="group" aria-labelledby="metadata-tags-label">
            <MetadataTagRows tags={tagList} onDelete={(tag) => setTagList(tagList.filter((item) => item !== tag))} />
            {tagList.length === 0 && <StatusLine>还没有标签</StatusLine>}
          </div>
          <label className="metadata-tag-input">
            <input
              ref={tagInputRef}
              aria-label="添加标签"
              enterKeyHint="enter"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="输入标签后回车，例如 artist:someone"
              value={tagDraft}
              autoComplete="off"
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter/backspace are composition controls while an IME is
                // active; treating them as tag commands corrupts Chinese input.
                const composing = event.nativeEvent.isComposing || event.keyCode === 229;
                if (composing) return;
                if (event.key === 'Enter') { event.preventDefault(); commitTagDraft(tagDraft); }
                else if (event.key === 'Backspace' && !tagDraft && tagList.length > 0) {
                  setTagList(tagList.slice(0, -1));
                }
              }}
            />
            {/* Same suggestion list the library search uses, so a namespace does
                not have to be typed from memory. */}
            {/* `exact={false}`：这里写进去的是标签本身。库检索那边要的是 `$` 结尾的精确
                查询，元数据里带上它就等于存了一条别人认不出来的标签。 */}
            {!busy && <TagSuggest inputValue={tagDraft} anchorRef={tagInputRef} exact={false} onSelect={(tag) => commitTagDraft(tag)} />}
          </label>
        </div>
        <label>简介<AutoTextarea value={summary} autoCapitalize="sentences" spellCheck onChange={(event) => setSummary(event.target.value)} rows={8} /></label>
        {plugins.length > 0 && <div className="metadata-plugin-row"><SelectField name="metadataPlugin" aria-label="元数据插件" value={plugin} onChange={setPlugin} options={plugins.map((item) => ({ value: item.id, label: item.name }))} /><button className="secondary-action" type="button" disabled={!!busy} onClick={() => void runPlugin()}><Play aria-hidden="true" />执行插件</button></div>}
        {pluginError && <div><StatusLine tone="error">插件列表读取失败：{pluginError}</StatusLine><button className="secondary-action" type="button" onClick={() => setPluginReload(value => value + 1)}><RotateCcw aria-hidden="true" />重新读取插件</button></div>}
      {/* Same as the sync panel: a save landing or failing is an event, and the
          toast is where events are reported. */}
        <div className="metadata-edit-actions">
          <button className="primary-action" type="submit" aria-label="保存元数据" disabled={!!busy}><Save aria-hidden="true" />{busy === 'save' ? '保存中…' : '保存元数据'}</button>
          <Link className="secondary-action" to={`/reader/${archiveId}${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`}><BookOpen aria-hidden="true" />阅读</Link>
          <button className="secondary-action metadata-delete-action" type="button" disabled={!!busy} onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" />删除</button>
        </div>
        </fieldset>
      </form>
      {deleteOpen && serverId && <ArchiveDeleteDialog archive={{ serverId, archiveId, title }} onClose={() => setDeleteOpen(false)} onDeleted={() => navigate('/library', { replace: true })} />}
    </main>
  );
}
