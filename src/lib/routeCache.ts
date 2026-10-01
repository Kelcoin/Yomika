/** Cross-route snapshots so switching pages and coming back does not start from
 * an empty screen — and, while a snapshot is fresh, does not refetch either.
 *
 * This used to be deliberately stale-while-revalidate: render the snapshot and
 * refresh anyway, on the grounds that the request was a local SQLite query.
 * The library list now comes from LANraragi over HTTP, so a refresh on every
 * mount is a round trip the user pays for each time they switch tabs. A route
 * reads its snapshot with a max age it chooses, and skips the fetch while that
 * holds; anything older revalidates as before.
 *
 * 一个进程结束，这份 Map 就什么都不剩，于是每次启动都必然先画一屏骨架。写入时
 * 明确标了 `persist` 的条目会同时落到 localStorage，由本模块在求值的那一刻同步
 * hydrate 回内存——路由第一次 render 读到的就是上一次进程留下的快照
 * （见 `writeRouteCache` 与 `hydrateRouteCache`）。
 */
interface CacheEntry {
  value: unknown;
  at: number;
  /** Approximate retained size, used by the byte budget below. */
  size: number;
}

/** 落盘副本的形状：`{ key: { at, size, value } }`。`at` 原样保留，所以
 * `maxAgeMs` 的 TTL 语义跨重启仍然成立（档案库那条读的是 `Infinity`，本来
 * 就不受 TTL 限制）。 */
interface PersistedEntry {
  at: number;
  size: number;
  value: unknown;
}

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
/** Snapshots are written per archive visited (three detail keys each) plus one
 * per recommendation page and one library page, so an unbounded map grew with
 * the library. Mostly small, but a library page holds hundreds of records. */
const MAX_ENTRIES = 64;
/** Big snapshots are the real risk: one library page can be megabytes, so the
 * entry count alone is not a bound. */
const MAX_BYTES = 8 * 1024 * 1024;
/** Depth to walk when measuring; enough to count records without serializing
 * every byte of a large snapshot on each write. */
const SIZE_DEPTH = 3;

/** 落盘副本所在的单个 localStorage 键。 */
const PERSIST_KEY = 'yomika.route-cache.v1';
/** 落盘的两档上限都比内存小：这份 JSON 要在模块求值时同步解析（第一次 render
 * 之前），解析得越久启动白屏越长。内存那 64 条 / 8MiB 服务的是整场会话里来回
 * 切路由，而落盘只需要撑住「下次启动的第一帧」——几条最常回访的页面就够。 */
const PERSIST_MAX_ENTRIES = 8;
const PERSIST_MAX_BYTES = 4 * 1024 * 1024;
/** 单条超过这个大小的干脆不落盘：localStorage 是同步 API，一条几 MB 的 JSON
 * 每次写都要在主线程上串行化并占满配额，而内存里那一份已经够本次会话用了。 */
const PERSIST_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

const entries = new Map<string, CacheEntry>();
let totalBytes = 0;

/** 落盘副本的内存镜像，与 localStorage 里的内容一一对应。淘汰顺序就是这份
 * Map 的插入顺序，所以写的时候不必回头解析磁盘。 */
const persisted = new Map<string, PersistedEntry>();
let persistedBytes = 0;

function estimateSize(value: unknown, depth = SIZE_DEPTH): number {
  if (value === null || value === undefined) return 8;
  switch (typeof value) {
    case 'string':
      return value.length * 2;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 4;
    default:
      break;
  }
  if (value instanceof Date) return 8;
  if (depth <= 0) return 16;
  if (Array.isArray(value)) {
    let sum = 16;
    for (const item of value) sum += estimateSize(item, depth - 1);
    return sum;
  }
  if (typeof value === 'object') {
    let sum = 16;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sum += key.length * 2 + estimateSize(item, depth - 1);
    }
    return sum;
  }
  return 0;
}

function dropEntry(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalBytes -= entry.size;
  if (totalBytes < 0) totalBytes = 0;
}

/** Insertion order is the eviction order; a read re-inserts its key so the
 * snapshots actually being shown survive a burst of one-off detail visits. */
function evictOverBudget(): void {
  while (entries.size > MAX_ENTRIES || (totalBytes > MAX_BYTES && entries.size > 1)) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    dropEntry(oldest.value);
  }
}

/** localStorage 在隐私模式、被策略禁用或沙箱 iframe 里连读属性都可能抛，所以
 * 每次访问都自己兜一手；拿不到就当作「这台机器没有持久化」。 */
function routeCacheStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** 把内存镜像写回磁盘。写失败（配额用尽、被禁用、PrivacyError）只吞掉，绝不抛
 * 给调用方；同时**不**在失败时去 `removeItem`——上一次成功落盘的副本比一个空
 * 存储有用，一次写不进去不该让用户下次启动比这次更糟。 */
function persistRouteCache(): void {
  const storage = routeCacheStorage();
  if (!storage) return;
  try {
    if (persisted.size === 0) {
      storage.removeItem(PERSIST_KEY);
      return;
    }
    const payload: Record<string, PersistedEntry> = {};
    for (const [key, entry] of persisted) payload[key] = entry;
    storage.setItem(PERSIST_KEY, JSON.stringify(payload));
  } catch {
    // 静默降级成纯内存：内存镜像仍是「本该落盘的样子」，下一次写成功时会补上。
  }
}

function removePersistedPayload(): void {
  const storage = routeCacheStorage();
  if (!storage) return;
  try {
    storage.removeItem(PERSIST_KEY);
  } catch {
    // 删不掉就当作没有落盘副本。
  }
}

/** 删一条落盘副本，返回是否真的删掉了（调用方据此决定要不要写回存储）。 */
function dropPersistedEntry(key: string): boolean {
  const entry = persisted.get(key);
  if (!entry) return false;
  persisted.delete(key);
  persistedBytes -= entry.size;
  if (persistedBytes < 0) persistedBytes = 0;
  return true;
}

/** 落盘的淘汰：先按条数，再按字节，插入顺序就是淘汰顺序（与内存那套一致）。
 * 返回是否真的淘汰过，用来决定要不要把裁过的结果写回磁盘。 */
function evictPersistedOverBudget(): boolean {
  let dropped = false;
  while (persisted.size > PERSIST_MAX_ENTRIES || (persistedBytes > PERSIST_MAX_BYTES && persisted.size > 1)) {
    const oldest = persisted.keys().next();
    if (oldest.done) break;
    dropPersistedEntry(oldest.value);
    dropped = true;
  }
  return dropped;
}

/** 磁盘上的东西是外部数据，形状对不上（`at` 不是数字、没有 `value`）一律不认。 */
function isPersistedEntry(value: unknown): value is PersistedEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<PersistedEntry>;
  return typeof entry.at === 'number' && Number.isFinite(entry.at) && 'value' in entry;
}

/** 清空内存后只从 localStorage 重建：模块求值时跑一次，测试里用
 * `simulateRouteCacheRestartForTests()` 再跑。同步做这件事是有意的——第一次
 * render 调用 `readRouteCache` 之前这份快照就得在内存里，否则「启动先显示缓存」
 * 永远轮不到。
 *
 * 坏 JSON / 结构不对一律静默丢弃并清掉那份副本，不抛也不写回垃圾。 */
function hydrateRouteCache(): void {
  entries.clear();
  totalBytes = 0;
  persisted.clear();
  persistedBytes = 0;

  const storage = routeCacheStorage();
  if (!storage) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem(PERSIST_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removePersistedPayload();
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    removePersistedPayload();
    return;
  }

  let changed = false;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isPersistedEntry(value)) {
      changed = true;
      continue;
    }
    // size 缺失或不可信就重算：内存预算是照着它扣的，外部数字不能直接采信。
    const size = typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
      ? value.size
      : estimateSize(value.value);
    persisted.set(key, { at: value.at, size, value: value.value });
    persistedBytes += size;
    // 同一份同时灌进内存：readRouteCache 只看那一份，重启后的第一帧才有东西可读。
    entries.set(key, { value: value.value, at: value.at, size });
    totalBytes += size;
  }

  if (evictPersistedOverBudget()) changed = true;
  // 磁盘上的条数本来就在内存上限之内；这一步只防被改过的存储把内存撑爆。
  evictOverBudget();
  if (changed) persistRouteCache();
}

/** 读一份快照；比 `maxAgeMs` 更旧的一律当作没有。读到会把该条移到 LRU 尾部，
 * 让正在显示的页面在一次性的详情浏览里活下来。 */
export function readRouteCache<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > maxAgeMs) {
    dropEntry(key);
    // 已经判定过期的快照不该继续躺在磁盘上：留着的话每次启动都会把它 hydrate
    // 回来、在这里再判一次死刑。
    if (dropPersistedEntry(key)) persistRouteCache();
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  return entry.value as T;
}

/** Age of a snapshot in milliseconds, or `undefined` if there is none. Lets a
 * route render a slightly older snapshot while still deciding to revalidate. */
export function routeCacheAge(key: string): number | undefined {
  const entry = entries.get(key);
  return entry ? Date.now() - entry.at : undefined;
}

/** 写入选项。`persist: true` 表示这一条还要落到 localStorage、跨进程重启仍在；
 * 不传（或 `persist: false`）与今天完全一致：纯内存。 */
export interface RouteCacheWriteOptions {
  persist?: boolean;
}

/** 写一份快照。只有 `persist: true` 的条目会落盘；默认行为与不做持久化时完全
 * 一致。落盘失败只会降级成纯内存，不抛异常。 */
export function writeRouteCache(key: string, value: unknown, options?: RouteCacheWriteOptions): void {
  dropEntry(key);
  const entry: CacheEntry = { value, at: Date.now(), size: estimateSize(value) };
  entries.set(key, entry);
  totalBytes += entry.size;
  evictOverBudget();

  if (options?.persist !== true) {
    // 同一个 key 后来的非持久化写入意味着「这一刻的值不该跨重启」：留着旧副本
    // 只会让下次启动 hydrate 回一个更旧的值。
    if (dropPersistedEntry(key)) persistRouteCache();
    return;
  }
  if (entry.size > PERSIST_MAX_ENTRY_BYTES) {
    // 太大的一条只在内存里；顺手清掉这个 key 曾落盘的旧副本。
    if (dropPersistedEntry(key)) persistRouteCache();
    return;
  }

  dropPersistedEntry(key); // 重新插入，把淘汰顺序推到最新
  persisted.set(key, { at: entry.at, size: entry.size, value });
  persistedBytes += entry.size;
  evictPersistedOverBudget();
  persistRouteCache();
}

/** Retained byte total, for tests and diagnostics. */
export function routeCacheBytesForTests(): number {
  return totalBytes;
}

export function invalidateRouteCache(prefix?: string): void {
  if (!prefix) {
    entries.clear();
    totalBytes = 0;
    persisted.clear();
    persistedBytes = 0;
  } else {
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) dropEntry(key);
    }
    // 前缀匹配必须和内存那套完全一致（`startsWith`），否则重启后失效的副本复活。
    for (const key of [...persisted.keys()]) {
      if (key.startsWith(prefix)) dropPersistedEntry(key);
    }
  }
  if (typeof window !== 'undefined') {
    // 先把存储写回再广播：监听者收到广播时不该还能看到一个已失效的副本。
    persistRouteCache();
    window.dispatchEvent(new CustomEvent('yomika:route-cache-invalidated', { detail: { prefix } }));
  }
}

export function resetRouteCacheForTests(): void {
  entries.clear();
  totalBytes = 0;
}

/** 测试用：模拟一次「进程重启」——清空内存后只从 localStorage 重新 hydrate，
 * 这样测试才能证明落盘的快照真的跨过了进程边界。 */
export function simulateRouteCacheRestartForTests(): void {
  hydrateRouteCache();
}

// 模块求值时就同步读回上一次进程留下的快照：应用里第一次 render 之前。
hydrateRouteCache();
