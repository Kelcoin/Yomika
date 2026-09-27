/** 标签补全排序数据（docs/30）：E-Hentai 标签的全站使用频次。
 *
 * 数据源与 JHenTai 同一份：mokurin000/e-hentai-tag-count 的 release 资产
 * `tagname_count.csv.gz`（行格式 `namespace:key,count`）。启用「标签补全排序规则」后
 * 后台拉取，补全建议在同分内按使用频次排序。
 *
 * 数据只驻内存；跨会话持久化的是版本号——下次启动先查版本，同版本才不重复下载，
 * 不同版本重新拉取（拉取在后台，补全在数据就绪前用默认排序，不阻塞任何交互）。
 */

export const TAG_COUNT_RELEASES_LATEST_URL = 'https://api.github.com/repos/mokurin000/e-hentai-tag-count/releases/latest';
export const TAG_COUNT_DOWNLOAD_BASE_URL = 'https://github.com/mokurin000/e-hentai-tag-count/releases/download';
export const TAG_COUNT_VERSION_KEY = 'yomika.tagcount.version';
export const TAG_COUNT_DATA_KEY = 'yomika.tagcount.data';
/** 频次低于这个数的标签不参与排序：长尾里没有想要的补全候选。与 JHenTai 同口径。 */
export const TAG_COUNT_MIN_COUNT = 5;

export interface TagCountService {
  getCount(namespaceWithKey: string): number | undefined;
  getVersion(): string | undefined;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

type UnknownRecord = Record<string, unknown>;

export function createTagCountService(options: TagCountServiceOptions = {}): TagCountService {
  const storage = options.storage ?? (() => {
    try { return window.localStorage; } catch { return undefined; }
  })();
  const fetcher = options.fetcher ?? window.fetch.bind(window);
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };

  const counts = new Map<string, number>();
  let version: string | undefined = (() => {
    try { return storage?.getItem(TAG_COUNT_VERSION_KEY) ?? undefined; } catch { return undefined; }
  })();
  // 数据随会话持久化在 localStorage（尽力而为，超配额则跳过）：启动时恢复，
  // 避免每次启动都为版本检查通过的数据重新下载十几 MB。
  try {
    const persisted = storage?.getItem(TAG_COUNT_DATA_KEY);
    if (persisted && version) {
      for (const line of persisted.split('\n')) {
        const tab = line.lastIndexOf('\t');
        if (tab <= 0) continue;
        const count = Number(line.slice(tab + 1));
        if (Number.isFinite(count)) counts.set(line.slice(0, tab), count);
      }
    }
  } catch { /* storage unavailable */ }
  let inFlight: Promise<void> | undefined;

  const notifyAndStore = (tag: string) => {
    try { storage?.setItem(TAG_COUNT_VERSION_KEY, tag); } catch { /* quota */ }
    version = tag;
    notify();
  };

  const parseCsv = async (bytes: ArrayBuffer): Promise<void> => {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    counts.clear();
    for (const line of text.split('\n')) {
      const comma = line.lastIndexOf(',');
      if (comma <= 0) continue;
      const key = line.slice(0, comma).replaceAll('"', '').trim();
      const count = Number(line.slice(comma + 1));
      if (!key || !Number.isFinite(count) || count < TAG_COUNT_MIN_COUNT) continue;
      counts.set(key, count);
    }
    if (counts.size === 0) throw new Error('Tag count data is empty');
    // 尽力持久化：放不下（配额）就只留版本号，下次启动走重新下载。
    const TAB = String.fromCharCode(9);
    const NEWLINE = String.fromCharCode(10);
    try {
      storage?.setItem(TAG_COUNT_DATA_KEY, [...counts].map(([key, count]) => `${key}${TAB}${count}`).join(NEWLINE));
    } catch { /* quota */ }
  };

  return {
    getCount(namespaceWithKey: string) {
      return counts.get(namespaceWithKey);
    },
    getVersion() {
      return version;
    },
    async refresh() {
      if (inFlight) return inFlight;
      const operation = (async () => {
        // 版本检查：GitHub API 带 CORS 头；同版本直接跳过下载。
        const release = await fetcher(`${TAG_COUNT_RELEASES_LATEST_URL}?_=${now()}`, { cache: 'no-store' });
        if (!release.ok) throw new Error(`Tag count release check failed with HTTP ${release.status}`);
        const releaseTag = ((await release.json() as UnknownRecord).tag_name as string | undefined)?.trim();
        if (!releaseTag) throw new Error('Tag count release has no tag name');
        if (releaseTag === version && counts.size > 0) { notifyAndStore(releaseTag); return; }
        const asset = await fetcher(`${TAG_COUNT_DOWNLOAD_BASE_URL}/${releaseTag}/tagname_count.csv.gz`, { cache: 'no-store' });
        if (!asset.ok) throw new Error(`Tag count download failed with HTTP ${asset.status}`);
        await parseCsv(await asset.arrayBuffer());
        notifyAndStore(releaseTag);
      })();
      inFlight = operation.finally(() => { if (inFlight === operation) inFlight = undefined; });
      return inFlight;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface TagCountServiceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  fetcher?: typeof fetch;
  now?: () => number;
}

const tagCountService = createTagCountService();
let countOrderEnabled = false;

export function setTagCountOrderEnabled(enabled: boolean): void {
  countOrderEnabled = enabled;
}
export function isTagCountOrderEnabled(): boolean {
  return countOrderEnabled;
}
export function getTagCountForSort(namespaceWithKey: string): number {
  if (!countOrderEnabled) return 0;
  return tagCountService.getCount(namespaceWithKey) ?? 0;
}
export function getTagCountVersion(): string | undefined {
  return tagCountService.getVersion();
}
export function refreshTagCounts(): Promise<void> {
  return tagCountService.refresh().then(() => undefined);
}
export function subscribeTagCountChanges(listener: () => void): () => void {
  return tagCountService.subscribe(listener);
}
