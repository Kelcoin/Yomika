/** 标签补全排序数据（docs/30）：E-Hentai 标签的全站使用频次。
 *
 * 数据源与 JHenTai 同一份：mokurin000/e-hentai-tag-count 的 release 资产
 * `tagname_count.csv.gz`（行格式 `namespace:key,count`）。启用「标签补全排序规则」后
 * 后台拉取，补全建议在同分内按使用频次排序。
 *
 * **下载在 Rust 侧**（`src-tauri/src/tagcount.rs` 的 `fetch_tag_counts`），不在这里
 * fetch：那份资产的终点 `release-assets.githubusercontent.com` 不发
 * `Access-Control-Allow-Origin`，WebView 里 `fetch` 拿到的是 `TypeError: Failed to
 * fetch`，改 CSP 也救不了（真浏览器读数见 `debug_outputs/tagcount/cors-probe.mjs`）。
 * 这里只负责「装上表、记住版本、通知订阅者」。
 *
 * 数据只驻内存；跨会话持久化的是版本号与整张表——下次启动先用存下来的表，再问
 * Rust 版本有没有变（没变就不下载正文）。
 */

import { z } from 'zod';

import { invokeCommand } from '../bridge/invoke';

/** Rust 命令名，与 `src-tauri/src/lib.rs` 的 `generate_handler!` 一致。 */
export const TAG_COUNT_TABLE_COMMAND = 'fetch_tag_counts';
export const TAG_COUNT_VERSION_KEY = 'yomika.tagcount.version';
export const TAG_COUNT_DATA_KEY = 'yomika.tagcount.data';
/** 频次低于这个数的标签不参与排序：长尾里没有想要的补全候选。与 JHenTai 同口径。 */
export const TAG_COUNT_MIN_COUNT = 5;

export interface TagCountTable {
  /** 数据版本：资产最后的修改时间（每天一个 release）。 */
  version: string;
  /** 版本没变时为真，此时 `data` 不带上，表照旧的用。 */
  unchanged: boolean;
  /** `key<TAB>count` 按行拼成的整表。数据没变时为空。 */
  data?: string | undefined;
}

export interface TagCountService {
  getCount(namespaceWithKey: string): number | undefined;
  getVersion(): string | undefined;
  install(entries: Iterable<[string, number]>): void;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const TagCountTableSchema = z.object({
  version: z.string(),
  unchanged: z.boolean(),
  data: z.string().nullish(),
});

type TableFetcher = (since: string | undefined) => Promise<TagCountTable>;

async function fetchTagCountTable(since: string | undefined): Promise<TagCountTable> {
  const result = await invokeCommand(
    TAG_COUNT_TABLE_COMMAND,
    { since: since ?? null },
    TagCountTableSchema,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  const table = result.value;
  if (!table.unchanged && !table.data) {
    throw new Error('Tag count table came back without its rows');
  }
  return { version: table.version, unchanged: table.unchanged, data: table.data ?? undefined };
}

export function createTagCountService(options: TagCountServiceOptions = {}): TagCountService {
  const storage = options.storage ?? (() => {
    try { return window.localStorage; } catch { return undefined; }
  })();
  const fetchTable = options.fetchTable ?? fetchTagCountTable;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };

  const counts = new Map<string, number>();
  let version: string | undefined = (() => {
    try { return storage?.getItem(TAG_COUNT_VERSION_KEY) ?? undefined; } catch { return undefined; }
  })();

  // 频次表的唯一入口：低于 TAG_COUNT_MIN_COUNT 的条目在这里就被丢掉，所以
  // 「哪些条目参与排序」只有一个地方说了算——Rust 传来的整表、启动时恢复的
  // localStorage 表、离线导入共用的都是这一条规则。
  const install = (entries: Iterable<[string, number]>) => {
    counts.clear();
    for (const [key, count] of entries) {
      if (!key || !Number.isFinite(count) || count < TAG_COUNT_MIN_COUNT) continue;
      counts.set(key, count);
    }
  };

  const readStoredRows = (rowText: string): Iterable<[string, number]> => {
    const entries: Array<[string, number]> = [];
    for (const line of rowText.split('\n')) {
      const tab = line.lastIndexOf('\t');
      if (tab <= 0) continue;
      entries.push([line.slice(0, tab), Number(line.slice(tab + 1))]);
    }
    // Rust 送来的是同一套 `key<TAB>count` 行；这里先落成数组再交给 install，
    // 与启动恢复走同一条路，免得两处各自过滤。
    return entries;
  };

  // 数据随会话持久化在 localStorage（尽力而为，超配额则跳过）：启动时恢复，
  // 避免每次启动都为没变的版本重新下载整表。
  try {
    const persisted = storage?.getItem(TAG_COUNT_DATA_KEY);
    if (persisted && version) install(readStoredRows(persisted));
  } catch { /* storage unavailable */ }

  let inFlight: Promise<void> | undefined;

  const notifyAndStore = (newVersion: string) => {
    try { storage?.setItem(TAG_COUNT_VERSION_KEY, newVersion); } catch { /* quota */ }
    version = newVersion;
    notify();
  };

  const persistRows = () => {
    const TAB = String.fromCharCode(9);
    const NEWLINE = String.fromCharCode(10);
    try {
      storage?.setItem(
        TAG_COUNT_DATA_KEY,
        [...counts].map(([key, count]) => `${key}${TAB}${count}`).join(NEWLINE),
      );
    } catch { /* quota */ }
  };

  return {
    getCount(namespaceWithKey: string) {
      return counts.get(namespaceWithKey);
    },
    getVersion() {
      return version;
    },
    install,
    async refresh() {
      if (inFlight) return inFlight;
      const operation = (async () => {
        // 手里已经有表才敢说「这个版本我已经有了」：只有版本号而没有表（比如清过
        // localStorage）时必须让 Rust 把正文带回来，否则排序会静悄悄地空掉。
        const table = await fetchTable(counts.size > 0 ? version : undefined);
        if (table.unchanged) { notifyAndStore(table.version); return; }
        install(readStoredRows(table.data ?? ''));
        if (counts.size === 0) throw new Error('Tag count data is empty');
        persistRows();
        notifyAndStore(table.version);
      })();
      // inFlight 存的是**这一趟本身**，把它交给调用方的那个 `.finally` 去清：
      // 写成 `inFlight = operation.finally(...)` 的话，回调里比较的是包装后的新
      // promise 与 `operation`，永远不相等——inFlight 从此不清，第二次刷新直接
      // 返回上一次的结果：成功后按刷新没反应，失败后每次都拿同一份旧错误。
      inFlight = operation;
      return operation.finally(() => { if (inFlight === operation) inFlight = undefined; });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface TagCountServiceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** 测试与离线场景的注入点：默认走 `fetch_tag_counts` 命令。 */
  fetchTable?: TableFetcher;
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
/** 这张表本身的读数，不带「标签补全排序规则」那个开关：推荐加权要用的是全站频次
 *  这件事本身，和补全建议排不排序没关系——那个开关只决定建议列表的次序。
 *  表还没装上时返回 undefined，调用方据此退回到原来的手写权重。 */
export function getTagFrequency(namespaceWithKey: string): number | undefined {
  return tagCountService.getCount(namespaceWithKey);
}
export function getTagCountVersion(): string | undefined {
  return tagCountService.getVersion();
}
/** 直接装一份频次表（`namespace:key` → 次数），与 `installTagTranslations` 对称：
 *  既是测试入口，也是离线导入的正式入口。低于 `TAG_COUNT_MIN_COUNT` 的条目会被丢弃。 */
export function installTagCounts(entries: Iterable<[string, number]>): void {
  tagCountService.install(entries);
}
export function refreshTagCounts(): Promise<void> {
  return tagCountService.refresh().then(() => undefined);
}
export function subscribeTagCountChanges(listener: () => void): () => void {
  return tagCountService.subscribe(listener);
}
