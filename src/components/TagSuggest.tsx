import { usePageActive } from '../app/RetainedPage';
import { useEffect, useId, useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { NS_CN_LABELS, searchTags, type TagSuggestion } from '../lib/tags';

interface TagSuggestProps {
  inputValue: string;
  anchorRef: RefObject<HTMLElement>;
  onSelect: (tag: string) => void;
  /** 选中的值是否带精确查询后缀 `$`（LANraragi 的检索语法）。
   *
   * 库检索要它（`female:glasses$` 才是「正好是这条」）；元数据编辑不要——那里写进去的
   * 就是标签本身，带上 `$` 等于存了一个别人认不出来的标签（`female:glasses$`）。 */
  exact?: boolean;
}

export function TagSuggest({ inputValue, anchorRef, onSelect, exact = true }: TagSuggestProps) {
  const pageActive = usePageActive();
  const panelId = useId();
  const optionId = (index: number) => `${panelId}-option-${index}`;
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number }>();
  const token = useMemo(() => inputValue.slice(inputValue.lastIndexOf(',') + 1).trim(), [inputValue]);
  const suggestions = useMemo(() => searchTags(token), [token]);

  useEffect(() => setActive(0), [token]);
  useEffect(() => {
    if (!pageActive || !suggestions.length || !anchorRef.current) { setPosition(undefined); return; }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPosition({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [anchorRef, suggestions.length, pageActive]);
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!suggestions.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % suggestions.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value - 1 + suggestions.length) % suggestions.length); }
      else if (event.key === 'Enter' && suggestions[active]) { event.preventDefault(); onSelect(formatSuggestion(suggestions[active], exact)); }
      else if (event.key === 'Escape') setPosition(undefined);
    };
    input.addEventListener('keydown', onKeyDown);
    return () => input.removeEventListener('keydown', onKeyDown);
  }, [active, anchorRef, exact, onSelect, suggestions]);
  // The anchor input belongs to the caller, so wire the combobox relationship
  // onto it here: without this a screen reader never hears the candidate list.
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return undefined;
    const open = Boolean(position) && suggestions.length > 0;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', panelId);
    input.setAttribute('aria-expanded', String(open));
    if (open) input.setAttribute('aria-activedescendant', optionId(active));
    else input.removeAttribute('aria-activedescendant');
    return () => {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
  }, [active, anchorRef, position, suggestions.length]);
  if (!pageActive || !position || !suggestions.length || typeof document === 'undefined') return null;
  return createPortal(
    <div className="tag-suggest-panel" id={panelId} role="listbox" style={{ position: 'fixed', left: position.left, top: position.top, width: position.width }}>
      {suggestions.map((suggestion, index) => (
        <button
          key={`${suggestion.namespace}:${suggestion.key}`}
          id={optionId(index)}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`tag-suggest-option${index === active ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => { event.preventDefault(); onSelect(formatSuggestion(suggestion, exact)); }}
        >
          <span className={`tag-suggest-badge tag-group-${suggestion.namespace}`}>{NS_CN_LABELS[suggestion.namespace] ?? suggestion.namespace}</span>
          <span className="tag-suggest-label">{suggestion.label}</span>
          <span className="tag-suggest-tag">{formatSuggestion(suggestion, exact)}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function formatSuggestion(suggestion: TagSuggestion, exact: boolean): string {
  return `${suggestion.namespace}:${suggestion.key}${exact ? '$' : ''}`;
}
