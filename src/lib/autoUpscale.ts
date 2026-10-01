interface AutoUpscaleOptions {
  enabled: boolean;
  tagMode: 'whitelist' | 'blacklist';
  pageCount: number;
  sizeBytes: number;
  thresholdBytes: number;
  whitelist: string;
  blacklist: string;
}

function tagSet(value: string): Set<string> {
  return new Set(value.split(/[\n,;]+/).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean));
}

/** 自动开启超分 = 体积那一半 + 标签那一半，两半都要过。
 *
 * 体积那一半是「平均一页比阈值**小**才值得超分」：设置里的阈值
 * （`SettingsWorkspace` 的 hint「平均每页体积，单位 KB」）是一道「这档案糊得值不值得
 * 超分」的线，本来就大的页再超只是白烧算力。方向曾经写反（平均体积 ≥ 阈值才开），
 * 用户报的第 ⑨ 条就是它。
 *
 * 数据不全时一律不开（页数非正，或平均体积/阈值不是有限正数）——自动开启宁可少开，
 * 不可在数据缺失的时候替用户做决定。
 */
export function shouldAutoEnableUpscale(tags: readonly string[], options: AutoUpscaleOptions): boolean {
  if (!options.enabled || options.pageCount <= 0) return false;
  const averageBytesPerPage = options.sizeBytes / options.pageCount;
  if (!Number.isFinite(averageBytesPerPage) || !Number.isFinite(options.thresholdBytes)) return false;
  if (averageBytesPerPage <= 0 || options.thresholdBytes <= 0) return false;
  if (averageBytesPerPage >= options.thresholdBytes) return false;
  const present = new Set(tags.map((tag) => tag.trim().toLocaleLowerCase()));
  const selected = tagSet(options.tagMode === 'whitelist' ? options.whitelist : options.blacklist);
  const matches = [...selected].some((tag) => present.has(tag));
  return options.tagMode === 'whitelist' ? matches : !matches;
}
