interface AutoUpscaleOptions {
  enabled: boolean;
  pageCount: number;
  sizeBytes: number;
  thresholdBytes: number;
  whitelist: string;
  blacklist: string;
}

function tagSet(value: string): Set<string> {
  return new Set(value.split(/[\n,;]+/).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean));
}

export function shouldAutoEnableUpscale(tags: readonly string[], options: AutoUpscaleOptions): boolean {
  if (!options.enabled || options.pageCount <= 0 || options.sizeBytes / options.pageCount < options.thresholdBytes) return false;
  const present = new Set(tags.map((tag) => tag.trim().toLocaleLowerCase()));
  const denied = tagSet(options.blacklist);
  if ([...denied].some((tag) => present.has(tag))) return false;
  const allowed = tagSet(options.whitelist);
  return allowed.size === 0 || [...allowed].some((tag) => present.has(tag));
}
