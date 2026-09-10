import { Link } from 'react-router-dom';

export function TagSearchLink({ label, query }: { label: string; query: string }) {
  // Match TagSuggest's committed fragment so the search box is immediately
  // ready for another exact tag.
  const search = new URLSearchParams({ q: `${query}, ` }).toString();
  return (
    <Link
      className="metadata-chip tag-search-link"
      to={`/library?${search}`}
      aria-label={`搜索标签 ${label}`}
      title={`搜索 ${label}`}
    >
      {label}
    </Link>
  );
}
