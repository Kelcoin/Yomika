import { parseArchiveTagString, tagIdentity } from './tags';

/** LANraragi's plugin response is an operation envelope, not archive metadata. */
export function metadataPluginResult(result: Record<string, unknown>, currentTags: string) {
  if (result.success === 0 || result.success === false || (typeof result.error === 'string' && result.error.trim())) {
    throw new Error(typeof result.error === 'string' ? result.error : '插件执行失败');
  }
  const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : result;
  const title = data.new_title ?? data.title;
  const summary = data.new_summary ?? data.summary;
  const incoming = data.new_tags ?? data.tags;
  const tags = typeof incoming === 'string' ? incoming : Array.isArray(incoming) ? incoming.filter((tag): tag is string => typeof tag === 'string').join(', ') : undefined;
  const combined = [...parseArchiveTagString(currentTags), ...parseArchiveTagString(tags ?? '')];
  const seen = new Set<string>();
  const merged = combined.filter(tag => { const key = tagIdentity(tag); if (seen.has(key)) return false; seen.add(key); return true; });
  return {
    title: typeof title === 'string' && title.trim() ? title : undefined,
    summary: typeof summary === 'string' ? summary : undefined,
    tags: tags === undefined ? undefined : merged.join(', '),
    changed: !!(typeof title === 'string' && title.trim()) || typeof summary === 'string' || !!tags?.trim(),
  };
}
