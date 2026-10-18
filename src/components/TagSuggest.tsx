import { usePageActive } from '../app/RetainedPage';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
  const panelRef = useRef<HTMLDivElement>(null);
  const optionId = (index: number) => `${panelId}-option-${index}`;
  /** 光标从「没有」开始（-1）：面板一开第一条就带选中态，看起来像「已经选了它」
   * （用户 2026-10-18：标签建议栏第一条一直显示成被选中状态）。这也正是 ARIA 组合框
   * 的写法——第一次 ArrowDown 落在第一条上，ArrowUp 落在最后一条上。Enter 仍然选第一
   * 条（没动过光标时 `active < 0`，取 `suggestions[0]`），那是原本就有的行为。 */
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean }>();
  const token = useMemo(() => inputValue.slice(inputValue.lastIndexOf(',') + 1).trim(), [inputValue]);
  const suggestions = useMemo(() => searchTags(token), [token]);

  useEffect(() => { setActive(-1); setDismissed(false); }, [token]);
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return;
    const focus = () => { setFocused(true); setDismissed(false); };
    const blur = () => setFocused(false);
    setFocused(document.activeElement === input);
    input.addEventListener('focus', focus);
    input.addEventListener('blur', blur);
    return () => { input.removeEventListener('focus', focus); input.removeEventListener('blur', blur); };
  }, [anchorRef]);
  useEffect(() => {
    if (!pageActive || !suggestions.length || !anchorRef.current) { setPosition(undefined); return; }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        const viewport = window.visualViewport;
        const viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportWidth = viewport?.width ?? window.innerWidth;
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
        const below = Math.max(0, viewportBottom - rect.bottom - 14);
        const above = Math.max(0, rect.top - viewportTop - 14);
        const flip = below < 120 && above > below;
        const maxHeight = Math.min(360, flip ? above : below);
        const width = Math.min(rect.width, Math.max(0, viewportWidth - 16));
        setPosition({ left: Math.max(viewportLeft + 8, Math.min(rect.left, viewportLeft + viewportWidth - width - 8)), top: flip ? rect.top - 6 : rect.bottom + 6, width, maxHeight, above: flip });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [anchorRef, suggestions.length, pageActive]);
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pageActive || !focused || dismissed || !position || !suggestions.length || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % suggestions.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value <= 0 ? suggestions.length - 1 : value - 1)); }
      else if (event.key === 'Enter' && suggestions[active < 0 ? 0 : active]) {
        event.preventDefault();
        // The editor/search input also handles Enter in React. One key must
        // choose the candidate once, without committing the unfinished token.
        // 没动过光标时 Enter 选第一条：光标从「没有」开始，但「直接回车」应当仍然有效。
        event.stopPropagation();
        onSelect(formatSuggestion(suggestions[active < 0 ? 0 : active]!, exact));
        setDismissed(true);
      }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); }
    };
    input.addEventListener('keydown', onKeyDown);
    return () => input.removeEventListener('keydown', onKeyDown);
  }, [active, anchorRef, exact, onSelect, suggestions, pageActive, focused, dismissed, position]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const option = panel?.children[active];
    if (!panel || !(option instanceof HTMLElement)) return;
    // Scroll this menu only: scrollIntoView can also move the editor/search
    // workspace underneath its fixed portal (especially with a soft keyboard).
    if (option.offsetTop < panel.scrollTop) panel.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = option.offsetTop + option.offsetHeight - panel.clientHeight;
    }
  }, [active, suggestions, pageActive, focused, dismissed, position]);
  // The anchor input belongs to the caller, so wire the combobox relationship
  // onto it here: without this a screen reader never hears the candidate list.
  useEffect(() => {
    const input = anchorRef.current;
    if (!input) return undefined;
    const open = pageActive && focused && !dismissed && Boolean(position) && suggestions.length > 0;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', panelId);
    input.setAttribute('aria-expanded', String(open));
    if (open && active >= 0) input.setAttribute('aria-activedescendant', optionId(active));
    else input.removeAttribute('aria-activedescendant');
    return () => {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
  }, [active, anchorRef, position, suggestions.length, pageActive, focused, dismissed]);
  if (!pageActive || !focused || dismissed || !position || !suggestions.length || typeof document === 'undefined') return null;
  return createPortal(
    <div ref={panelRef} className="tag-suggest-panel" id={panelId} role="listbox" style={{ position: 'fixed', left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.above ? 'translateY(-100%)' : undefined }}>
      {suggestions.map((suggestion, index) => {
        const highlighted = index === active;
        return (
          <button
            key={`${suggestion.namespace}:${suggestion.key}`}
            id={optionId(index)}
            type="button"
            role="option"
            aria-selected={highlighted}
            className={`tag-suggest-option${highlighted ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { onSelect(formatSuggestion(suggestion, exact)); setDismissed(true); }}
          >
            <span className={`tag-suggest-badge tag-group-${suggestion.namespace}`}>{NS_CN_LABELS[suggestion.namespace] ?? suggestion.namespace}</span>
            <span className="tag-suggest-label">{suggestion.label}</span>
            <span className="tag-suggest-tag">{formatSuggestion(suggestion, exact)}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

function formatSuggestion(suggestion: TagSuggestion, exact: boolean): string {
  return `${suggestion.namespace}:${suggestion.key}${exact ? '$' : ''}`;
}
