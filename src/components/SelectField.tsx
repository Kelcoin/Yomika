import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { usePageActive } from '../app/RetainedPage';

export interface SelectOption { value: string; label: string; }
interface SelectFieldProps {
  id?: string;
  name: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  optionAction?: (option: SelectOption) => ReactNode;
  /** Right of the trigger, before the chevron — the sort direction, for instance. */
  trailing?: ReactNode;
  /** Right of one option row. */
  optionTrailing?: (option: SelectOption) => ReactNode;
  'aria-label'?: string;
}

export function SelectField({ id, name, value, options, onChange, optionAction, trailing, optionTrailing, 'aria-label': ariaLabel }: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const pageActive = usePageActive();
  useLayoutEffect(() => { if (!pageActive) setOpen(false); }, [pageActive]);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const listId = `${id ?? name}-${instanceId}-options`;
  useOverlayBackGuard(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const option = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }, [open, value, options]);
  return (
    <div className="select-field" ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
        }
      }}
    >
      <select className="select-native-fallback" name={name} value={value} aria-label={ariaLabel} onChange={(event) => onChange(event.target.value)} tabIndex={-1}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <button
        ref={triggerRef}
        id={id}
        className="select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(open ? { 'aria-controls': listId } : {})}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') && !open) {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (!open || options.length === 0) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(false);
            return;
          }
          const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
          let nextIndex = currentIndex;
          if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
          else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = options.length - 1;
          else return;
          event.preventDefault();
          onChange(options[nextIndex]!.value);
        }}
      >
        <span>{selected?.label}</span>
        {trailing}
        <ChevronDown aria-hidden="true" />
      </button>
      {/* The chosen option is marked by its background alone: a tick on the right
          was one more mark per menu, and every one of them meant the same thing. */}
      {open && <div ref={menuRef} className="select-menu" id={listId} role="listbox" aria-label={ariaLabel}>
        {options.map((option) => <div className="select-option" role="option" aria-selected={option.value === value} key={option.value}>
          <button className="select-option-main" type="button" onClick={() => { onChange(option.value); setOpen(false); triggerRef.current?.focus(); }}><span>{option.label}</span></button>
          {optionTrailing?.(option)}
          {optionAction?.(option)}
        </div>)}
      </div>}
    </div>
  );
}
