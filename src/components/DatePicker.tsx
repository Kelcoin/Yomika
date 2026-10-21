import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { usePageActive } from '../app/RetainedPage';

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
const monthLabels = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 年份跨度按当前选中年份分组排列，一次显示 12 年，翻页步长也是 12。 */
const YEARS_PER_PAGE = 12;

export function DatePicker({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const selected = useMemo(() => parse(value), [value]);
  const [open, setOpen] = useState(false);
  const pageActive = usePageActive();
  useLayoutEffect(() => { if (!pageActive) setOpen(false); }, [pageActive]);
  /** 'days' 是日期网格，另外两档是快速跳年份/月份：只能靠左右箭头一个月一个
   * 月地挪，跨年份时要按几十下，等于没有导航。 */
  // 返回手势先收起这一层（见 overlayBackGuard）。
  useOverlayBackGuard(open, () => setOpen(false));
  const [pane, setPane] = useState<'days' | 'months' | 'years'>('days');
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const [yearPage, setYearPage] = useState(() => Math.floor(selected.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const root = rootRef.current;
      const popover = popoverRef.current;
      if (!root || !popover) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 12;
      const rect = root.getBoundingClientRect();
      const anchor = triggerRef.current?.getBoundingClientRect() ?? rect;
      const width = Math.min(280, Math.max(0, viewportWidth - 24));
      const x = Math.max(left, Math.min(anchor.left + (anchor.width - width) / 2, left + viewportWidth - 24 - width));
      const below = Math.max(0, bottom - rect.bottom - 6);
      const above = Math.max(0, rect.top - top - 6);
      const flip = below < popover.scrollHeight && above > below;
      setPopoverStyle({ left: x - rect.left, width, maxHeight: flip ? above : below,
        top: flip ? 'auto' : 'calc(100% + 6px)', bottom: flip ? 'calc(100% + 6px)' : 'auto', overflowY: 'auto' });
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    return () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('scroll', fit, true);
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
    };
  }, [open, pane, month]);
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  }, [month]);
  const years = useMemo(() => Array.from({ length: YEARS_PER_PAGE }, (_, index) => yearPage + index), [yearPage]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  const toggle = () => {
    setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    setYearPage(Math.floor(selected.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE);
    setPane('days');
    setOpen((current) => !current);
  };
  const shiftYears = (delta: number) => setMonth(new Date(month.getFullYear() + delta, month.getMonth(), 1));
  const shiftMonths = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  const close = () => { setOpen(false); triggerRef.current?.focus(); };

  return <div className="date-picker" ref={rootRef}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
      }
    }}
  >
    <span className="date-picker-label">{label}</span>
    <button ref={triggerRef} type="button" className="date-picker-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
      <CalendarDays aria-hidden="true" />{value}<ChevronRight aria-hidden="true" />
    </button>
    {open && <div ref={popoverRef} style={popoverStyle} className="date-picker-popover" role="dialog" aria-label={`${label}选择器`}>
      {pane === 'days' && <>
        <div className="date-picker-header">
          <button type="button" className="icon-button" aria-label="上一月" onClick={() => shiftMonths(-1)}><ChevronLeft /></button>
          {/* 年份和月份是两个独立的快速入口：点年份跳年份网格，点月份跳月份
              网格，不再共用一个「先月份、再年份」的标题按钮。 */}
          <div className="date-picker-heading-group">
            <button type="button" className="date-picker-heading" aria-label="选择年份" onClick={() => { setYearPage(Math.floor(month.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE); setPane('years'); }}>{month.getFullYear()}年</button>
            <button type="button" className="date-picker-heading" aria-label="选择月份" onClick={() => setPane('months')}>{month.getMonth() + 1}月</button>
          </div>
          <button type="button" className="icon-button" aria-label="下一月" onClick={() => shiftMonths(1)}><ChevronRight /></button>
        </div>
        <div className="date-picker-weekdays">{labels.map((item) => <span key={item}>{item}</span>)}</div>
        <div className="date-picker-days">{days.map((day, index) => day === null ? <span key={`empty-${index}`} /> : <button type="button" key={day} className={day === selected.getDate() && month.getMonth() === selected.getMonth() && month.getFullYear() === selected.getFullYear() ? 'is-selected' : ''} onClick={() => { onChange(format(new Date(month.getFullYear(), month.getMonth(), day))); close(); }}>{day}</button>)}</div>
      </>}
      {pane === 'months' && <>
        <div className="date-picker-header">
          <button type="button" className="icon-button" aria-label="上一年" onClick={() => shiftYears(-1)}><ChevronLeft /></button>
          <button type="button" className="date-picker-heading" aria-label="选择年份" onClick={() => { setYearPage(Math.floor(month.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE); setPane('years'); }}>{month.getFullYear()}年</button>
          <button type="button" className="icon-button" aria-label="下一年" onClick={() => shiftYears(1)}><ChevronRight /></button>
        </div>
        <div className="date-picker-grid is-months">{monthLabels.map((item, index) => <button type="button" key={item} className={index === month.getMonth() ? 'is-selected' : ''} onClick={() => { setMonth(new Date(month.getFullYear(), index, 1)); setPane('days'); }}>{item}</button>)}</div>
      </>}
      {pane === 'years' && <>
        <div className="date-picker-header">
          <button type="button" className="icon-button" aria-label="上十二年" onClick={() => setYearPage(yearPage - YEARS_PER_PAGE)}><ChevronLeft /></button>
          <strong>{yearPage} — {yearPage + YEARS_PER_PAGE - 1}</strong>
          <button type="button" className="icon-button" aria-label="下十二年" onClick={() => setYearPage(yearPage + YEARS_PER_PAGE)}><ChevronRight /></button>
        </div>
        <div className="date-picker-grid is-years">{years.map((year) => <button type="button" key={year} className={year === month.getFullYear() ? 'is-selected' : ''} onClick={() => { setMonth(new Date(year, month.getMonth(), 1)); setPane('months'); }}>{year}</button>)}</div>
      </>}
      <div className="date-picker-footer"><button type="button" className="secondary-action" onClick={() => { onChange(format(new Date())); close(); }}><CalendarDays aria-hidden="true" />今天</button><button type="button" className="secondary-action" onClick={close}><X aria-hidden="true" />取消</button></div>
    </div>}
  </div>;
}
