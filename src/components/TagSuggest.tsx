import { useEffect, useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { NS_CN_LABELS, searchTags, type TagSuggestion } from '../lib/tags';

interface TagSuggestProps {
  inputValue: string;
  anchorRef: RefObject<HTMLElement>;
  onSelect: (tag: string) => void;
}

const PANEL_ID = 'tag-suggest-panel';
const optionId = (index: number) => `${PANEL_ID}-option-${index}`;

export function TagSuggest({ inputValue, anchorRef, onSelect }: TagSuggestProps) {
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number }>();
  const token = useMemo(() => inputValue.slice(inputValue.lastIndexOf(',') + 1).trim(), [inputValue]);
  const suggestions = useMemo(() => searchTags(token), [token]);

  useEffect(() => setActive(0), [token]);
  useEffect(() => {
    if (!suggestions.length || !anchorRef.current) { setPosition(undefined); return; }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPosition({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [anchorRef, suggestions.length]);
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!suggestions.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % suggestions.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value - 1 + suggestions.length) % suggestions.length); }
      else if (event.key === 'Enter' && suggestions[active]) { event.preventDefault(); onSelect(formatSuggestion(suggestions[active])); }
      else if (event.key === 'Escape') setPosition(undefined);
    };
    input.addEventListener('keydown', onKeyDown);
    return () => input.removeEventListener('keydown', onKeyDown);
  }, [active, anchorRef, onSelect, suggestions]);
  // The anchor input belongs to the caller, so wire the combobox relationship
  // onto it here: without this a screen reader never hears the candidate list.
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return undefined;
    const open = Boolean(position) && suggestions.length > 0;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', PANEL_ID);
    input.setAttribute('aria-expanded', String(open));
    if (open) input.setAttribute('aria-activedescendant', optionId(active));
    else input.removeAttribute('aria-activedescendant');
    return () => {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
  }, [active, anchorRef, position, suggestions.length]);
  if (!position || !suggestions.length || typeof document === 'undefined') return null;
  return createPortal(
    <div className="tag-suggest-panel" id={PANEL_ID} role="listbox" style={{ position: 'fixed', left: position.left, top: position.top, width: position.width }}>
      {suggestions.map((suggestion, index) => (
        <button
          key={`${suggestion.namespace}:${suggestion.key}`}
          id={optionId(index)}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`tag-suggest-option${index === active ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => { event.preventDefault(); onSelect(formatSuggestion(suggestion)); }}
        >
          <span className="tag-suggest-badge">{NS_CN_LABELS[suggestion.namespace] ?? suggestion.namespace}</span>
          <span className="tag-suggest-label">{suggestion.label}</span>
          <span className="tag-suggest-tag">{suggestion.namespace}:{suggestion.key}$</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function formatSuggestion(suggestion: TagSuggestion): string {
  return `${suggestion.namespace}:${suggestion.key}$`;
}
