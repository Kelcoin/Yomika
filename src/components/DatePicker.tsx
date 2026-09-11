import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

function parse(value: string): Date {
  const parts = value.split('-').map(Number);
  const year = Number.isFinite(parts[0]) ? parts[0]! : new Date().getFullYear();
  const month = Number.isFinite(parts[1]) ? parts[1]! : 1;
  const day = Number.isFinite(parts[2]) ? parts[2]! : 1;
  return new Date(year, month - 1, day);
}
function format(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const labels = ['日', '一', '二', '三', '四', '五', '六'];

export function DatePicker({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const selected = useMemo(() => parse(value), [value]);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  }, [month]);
  return <div className="date-picker">
    <span className="date-picker-label">{label}</span>
    <button type="button" className="date-picker-trigger" aria-label={label} aria-expanded={open} onClick={() => { setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1)); setOpen((v) => !v); }}>
      <CalendarDays aria-hidden="true" />{value}<ChevronRight aria-hidden="true" />
    </button>
    {open && <div className="date-picker-popover" role="dialog" aria-label={`${label}选择器`}>
      <div className="date-picker-header"><button type="button" className="icon-button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft /></button><strong>{month.getFullYear()}年 {month.getMonth() + 1}月</strong><button type="button" className="icon-button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight /></button></div>
      <div className="date-picker-weekdays">{labels.map((item) => <span key={item}>{item}</span>)}</div>
      <div className="date-picker-days">{days.map((day, index) => day === null ? <span key={`empty-${index}`} /> : <button type="button" key={day} className={day === selected.getDate() && month.getMonth() === selected.getMonth() && month.getFullYear() === selected.getFullYear() ? 'is-selected' : ''} onClick={() => { onChange(format(new Date(month.getFullYear(), month.getMonth(), day))); setOpen(false); }}>{day}</button>)}</div>
      <div className="date-picker-footer"><button type="button" className="secondary-action" onClick={() => { onChange(format(new Date())); setOpen(false); }}>今天</button><button type="button" className="secondary-action" onClick={() => setOpen(false)}>取消</button></div>
    </div>}
  </div>;
}
