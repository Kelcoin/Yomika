/** When a typed query should reach the server.
 *
 * The search box used to submit on every keystroke, so typing `artist:foo`
 * fired eight searches; LANraragi rebuilds its search cache each time and the
 * requests pile up. Submit on Enter, on a suggestion pick, when the field is
 * cleared, or once the text ends a tag (`,` separates tags, `$` closes an exact
 * tag match).
 */
export function isCommittableSearchQuery(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return trimmed.endsWith(',') || trimmed.endsWith('$');
}
