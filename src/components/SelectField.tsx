import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface SelectOption { value: string; label: string; }
interface SelectFieldProps {
  id?: string;
  name: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  optionAction?: (option: SelectOption) => ReactNode;
  'aria-label'?: string;
}

export function SelectField({ id, name, value, options, onChange, optionAction, 'aria-label': ariaLabel }: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const listId = `${id ?? name}-options`;
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <div className="select-field" ref={rootRef}>
      <select className="select-native-fallback" name={name} value={value} aria-label={ariaLabel} onChange={(event) => onChange(event.target.value)} tabIndex={-1}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <button
        id={id}
        className="select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(open ? { 'aria-controls': listId } : {})}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label}</span><ChevronDown aria-hidden="true" />
      </button>
      {open && <div className="select-menu" id={listId} role="listbox" aria-label={ariaLabel}>
        {options.map((option) => <div className="select-option" role="option" aria-selected={option.value === value} key={option.value}>
          <button className="select-option-main" type="button" onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <Check aria-hidden="true" />}</button>
          {optionAction?.(option)}
        </div>)}
      </div>}
    </div>
  );
}
