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

export function shouldAutoEnableUpscale(tags: readonly string[], options: AutoUpscaleOptions): boolean {
  if (!options.enabled || options.pageCount <= 0 || options.sizeBytes / options.pageCount < options.thresholdBytes) return false;
  const present = new Set(tags.map((tag) => tag.trim().toLocaleLowerCase()));
  const selected = tagSet(options.tagMode === 'whitelist' ? options.whitelist : options.blacklist);
  const matches = [...selected].some((tag) => present.has(tag));
  return options.tagMode === 'whitelist' ? matches : !matches;
}
