import pinyin from 'tiny-pinyin';

import { formatArchiveDate } from './archiveCardPresentation';

export const TAG_NAMESPACE_LABELS: Record<string, string> = {
  artist: '作者', parody: '原作', category: '分类', reclass: '重分类', character: '角色', female: '女性', male: '男性', mixed: '混合', other: '其他', group: '社团', series: '系列', language: '语言', general: '通用', location: '地点', cosplayer: 'Cosplayer', uploader: '发布者', date_added: '添加日期', timestamp: '发布日期', source: '来源',
};
export const TAG_NAMESPACE_ORDER = ['artist', 'parody', 'category', 'reclass', 'character', 'female', 'male', 'mixed', 'other', 'group', 'series', 'language', 'location', 'cosplayer', 'general'];
export const TAG_BOTTOM_NAMESPACES = ['uploader', 'date_added', 'timestamp', 'source'];
export const FAVORITES_CATEGORY_NAME = '\u{1f516} Favorites';
export function getCategoryDisplayName(name: string): string { return name === FAVORITES_CATEGORY_NAME ? '收藏夹' : name; }
export function sortCategoriesForDisplay<T extends { name: string }>(categories: T[] = []): T[] {
  return [...categories].sort((left, right) => Number(right.name === FAVORITES_CATEGORY_NAME) - Number(left.name === FAVORITES_CATEGORY_NAME));
}
/** Categories an archive can be put into by hand. A dynamic category's contents
 * come from its search expression — LANraragi's own schema treats `archives` and
 * `search` as either/or — so offering one as a target would be a no-op. The
 * favourites category has its own toggle. */
export function assignableCategories<T extends { name: string; search?: string | null | undefined }>(categories: T[] = []): T[] {
  return categories.filter((category) => !category.search && category.name !== FAVORITES_CATEGORY_NAME);
}
/** The E-Hentai categories, in Chinese, keyed by every spelling they arrive in.
 *
 * One map, used by both consumers. There used to be two: this one, reached only
 * from the detail pane's tag list, and an English display-casing map in
 * `archiveCardPresentation` that the card footer used — so the same archive read
 * 漫画 in the panel and Manga on the card, and a neighbour with a category the
 * server knew about read Chinese while one without read English. This one also
 * covers the values the old map missed (`artist cg`, `gamecg`, `non-h`,
 * `asianporn`, `misc`), which is why some of them stayed English everywhere. */
export const CATEGORY_TRANSLATIONS: Record<string, string> = {
  manga: '漫画',
  doujinshi: '同人志',
  artistcg: '作者 CG',
  'artist cg': '作者 CG',
  gamecg: '游戏 CG',
  'game cg': '游戏 CG',
  imageset: '图片集',
  'image set': '图片集',
  western: '欧美',
  'non-h': '非 H',
  nonh: '非 H',
  cosplay: 'Cosplay',
  asianporn: '亚洲写真',
  'asian porn': '亚洲写真',
  misc: '杂项',
};

/** A `category:`/`reclass:` tag value in the form a card or a chip shows it. */
export function categoryTagLabel(value: string): string {
  const text = value.trim();
  return text ? CATEGORY_TRANSLATIONS[text.toLowerCase()] ?? text : text;
}
export type TranslationMap = Record<string, Record<string, string>>;
let translations: TranslationMap = {};
const listeners = new Set<() => void>();
export interface TagSuggestion { namespace: string; key: string; label: string; score: number; }

export function subscribeTagTranslations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const HTML_TAG = /<[^>]*>/g;
let entityDecoder: HTMLTextAreaElement | undefined;

// The upstream database holds 50k+ entries. A DOMParser document per entry
// froze the main thread for seconds, so strip markup textually and only touch
// the DOM for the minority of names that actually carry an entity.
function readableTranslationName(value: string): string {
  const stripped = value.includes('<') ? value.replace(HTML_TAG, '') : value;
  if (!stripped.includes('&') || typeof document === 'undefined') return stripped.trim();
  entityDecoder ??= document.createElement('textarea');
  entityDecoder.innerHTML = stripped;
  return (entityDecoder.value ?? stripped).trim();
}

export function normalizeTranslationDb(raw: unknown): TranslationMap {
  const result: TranslationMap = {};
  const root = raw as { data?: unknown };
  const addNamespace = (namespace: unknown, entries: unknown) => {
    const key = String(namespace ?? '').trim().toLowerCase();
    if (!key || !entries || typeof entries !== 'object' || Array.isArray(entries)) return;
    const normalized = Object.fromEntries(Object.entries(entries as Record<string, unknown>)
      .flatMap(([tag, item]) => {
        if (typeof item === 'string') return [[tag.toLowerCase(), readableTranslationName(item)] as const];
        if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
          return [[tag.toLowerCase(), readableTranslationName((item as { name: string }).name)] as const];
        }
        return [];
      }));
    if (Object.keys(normalized).length > 0) result[key] = normalized;
  };

  if (Array.isArray(root?.data)) {
    for (const section of root.data) {
      if (!section || typeof section !== 'object') continue;
      const value = section as { namespace?: unknown; data?: unknown };
      if (value.namespace === 'rows') continue;
      addNamespace(value.namespace, value.data);
    }
  } else if (root?.data && typeof root.data === 'object') {
    for (const [namespace, entries] of Object.entries(root.data as Record<string, unknown>)) addNamespace(namespace, entries);
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    // Some EhTagTranslation releases expose namespaces at the document root.
    for (const [namespace, entries] of Object.entries(raw as Record<string, unknown>)) addNamespace(namespace, entries);
  }
  return result;
}

export const NS_CN_LABELS: Record<string, string> = TAG_NAMESPACE_LABELS;
interface SearchIndexEntry {
  namespace: string;
  key: string;
  label: string;
  keyLower: string;
  labelLower: string;
  /** Full pinyin of the Chinese label, e.g. `yanjing` for 眼镜. */
  pinyin: string;
  /** First letter of each syllable, e.g. `yj`. */
  pinyinInitials: string;
}
let searchIndex: SearchIndexEntry[] = [];

/** Latin queries cannot reach a Chinese label: typing `yanjing` has to find
 * 眼镜 (female:glasses). Both the full pinyin and the initials are precomputed
 * with the label's lower case, because the suggest box searches per keystroke. */
function toPinyinForms(label: string): { pinyin: string; pinyinInitials: string } {
  if (!/[㐀-鿿]/.test(label)) return { pinyin: '', pinyinInitials: '' };
  try {
    const syllables = pinyin.convertToPinyin(label, ' ', true).split(/\s+/).filter(Boolean);
    if (syllables.length === 0) return { pinyin: '', pinyinInitials: '' };
    return {
      pinyin: syllables.join(''),
      pinyinInitials: syllables.map((syllable) => syllable[0] ?? '').join(''),
    };
  } catch {
    // A label outside the bundled character table simply has no pinyin form.
    return { pinyin: '', pinyinInitials: '' };
  }
}

function rebuildSearchIndex(): void {
  // Lower-casing here instead of per keystroke: the installed database holds
  // tens of thousands of entries and the suggest box searches on every input.
  searchIndex = Object.entries(translations).flatMap(([namespace, entries]) => Object.entries(entries).map(([key, label]) => ({
    namespace, key, label, keyLower: key.toLowerCase(), labelLower: label.toLowerCase(),
    ...toPinyinForms(label),
  })));
}

export function installTagTranslations(value: TranslationMap): void {
  translations = value;
  rebuildSearchIndex();
  for (const listener of listeners) listener();
}

export function isDBReady(): boolean { return searchIndex.length > 0; }

export function searchTags(query: string, limit = 30): TagSuggestion[] {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw || searchIndex.length === 0) return [];
  const namespaceQuery = raw.includes(':') ? raw.slice(0, raw.indexOf(':')).trim() : '';
  const valueQuery = namespaceQuery ? raw.slice(raw.indexOf(':') + 1).trim() : raw;
  const matches: TagSuggestion[] = [];
  for (const item of searchIndex) {
    if (namespaceQuery && item.namespace !== namespaceQuery) continue;
    const score = item.keyLower === valueQuery ? 100
      : item.keyLower.startsWith(valueQuery) ? 80
        : item.labelLower === valueQuery ? 70
          : item.labelLower.startsWith(valueQuery) ? 60
            // Pinyin ranks below the literal forms: an exact `yanjing` should
            // still lose to a tag literally named that.
            : item.pinyin === valueQuery ? 55
              : item.pinyin.startsWith(valueQuery) ? 45
                : item.pinyinInitials === valueQuery ? 40
                  : item.keyLower.includes(valueQuery) || item.labelLower.includes(valueQuery) ? 30
                    : item.pinyin.includes(valueQuery) ? 20
                      : 0;
    if (score) matches.push({ namespace: item.namespace, key: item.key, label: item.label, score });
  }
  return matches.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, limit);
}

export function translateTag(namespace: string, value: string): string {
  const text = value.trim(); const key = namespace.toLowerCase(); if (!text) return text;
  if (key === 'category' || key === 'reclass') return CATEGORY_TRANSLATIONS[text.toLowerCase()] ?? text;
  // Local calendar day, matching how card metadata renders the same timestamp.
  if (key === 'date_added' || key === 'timestamp') { const number = Number(text); if (Number.isFinite(number) && number > 0) { const formatted = formatArchiveDate(number > 1e12 ? number / 1000 : number); if (formatted) return formatted; } }
  return translations[key]?.[text.toLowerCase()] ?? text;
}
export function translateRawTag(raw: string): string {
  const separator = raw.indexOf(':');
  return separator > 0 ? translateTag(raw.slice(0, separator), raw.slice(separator + 1)) : translateTag('general', raw);
}
export function parseArchiveTagString(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}
export interface TagGroup { namespace: string; label: string; values: string[]; }
export function categorizeTags(tags: string[] = []): TagGroup[] {
  const groups = new Map<string, string[]>();
  for (const raw of tags) { const [head = '', ...rest] = raw.split(':'); const namespace = rest.length ? head.trim().toLowerCase() : 'general'; const value = rest.length ? rest.join(':').trim() : raw.trim(); if (!value) continue; groups.set(namespace, [...(groups.get(namespace) ?? []), translateTag(namespace, value)]); }
  const order = [...TAG_NAMESPACE_ORDER, ...TAG_BOTTOM_NAMESPACES];
  return [...groups.entries()].sort(([a], [b]) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)) || a.localeCompare(b)).map(([namespace, values]) => ({ namespace, label: TAG_NAMESPACE_LABELS[namespace] ?? namespace, values }));
}
