import { Link } from 'react-router-dom';

import { readableInkOnHex } from '../lib/ehMyTags';

export function TagSearchLink({ label, query, color }: { label: string; query: string; color?: string | undefined }) {
  // Match TagSuggest's committed fragment so the search box is immediately
  // ready for another exact tag.
  const search = new URLSearchParams({ q: `${query}, ` }).toString();
  return (
    <Link
      className="metadata-chip tag-search-link"
      to={`/library?${search}`}
      aria-label={`搜索标签 ${label}`}
      title={`搜索 ${label}`}
      /* A colour here is the E-Hentai account's own preset for this tag
         ("My Tags"); the ink follows the fill's luminance because the theme's
         chip ink knows nothing about an arbitrary user colour. */
      style={color ? { background: color, color: readableInkOnHex(color) } : undefined}
    >
      {label}
    </Link>
  );
}
