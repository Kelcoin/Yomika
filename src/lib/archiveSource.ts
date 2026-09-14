/** Only explicit HTTP(S) source tags are external navigation destinations. */
export function archiveSourceUrl(tags: readonly string[] = []): string | undefined {
  for (const tag of tags) {
    const separator = tag.indexOf(':');
    if (separator < 0 || tag.slice(0, separator).trim().toLowerCase() !== 'source') continue;
    const raw = tag.slice(separator + 1).trim();
    if (!/^https?:\/\//i.test(raw) || /\s/.test(raw)) continue;
    try {
      const url = new URL(raw);
      if (url.hostname && !url.username && !url.password) return url.href;
    } catch { /* Try the next source tag. */ }
  }
  return undefined;
}
