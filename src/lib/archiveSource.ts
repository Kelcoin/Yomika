/** Source metadata may omit the scheme; external navigation is always HTTP(S). */
export function archiveSourceUrl(tags: readonly string[] = []): string | undefined {
  for (const tag of tags) {
    const separator = tag.indexOf(':');
    if (separator < 0 || tag.slice(0, separator).trim().toLowerCase() !== 'source') continue;
    const raw = tag.slice(separator + 1).trim();
    if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) continue;
    // LANraragi source tags commonly store just e-hentai.org/g/... . Only
    // recognize domain-like inputs, never reinterpret another URL scheme.
    const candidate = /^https?:\/\//i.test(raw) ? raw
      : raw.startsWith('//') ? 'https:' + raw
        : /^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d{1,5})?(?:[/?#]|$)/i.test(raw) ? 'https://' + raw
          : undefined;
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password) return url.href;
    } catch { /* Try the next source tag. */ }
  }
  return undefined;
}
