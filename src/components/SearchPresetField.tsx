import { BookmarkPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { SearchPreset } from '../repositories/nativeLibraryRepository';

import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { usePageActive } from '../app/RetainedPage';
import { OverlayLayer } from './OverlayLayer';

/** 检索预设：一个按钮加一层手写浮层。档案库和本地档案页共用它——两边的搜索框
 * 是同一个控件，它右边的东西也该是同一个。 */
export function SearchPresetField({ presets, onApply, onSave, onEdit, onDelete }: {
  presets?: SearchPreset[] | undefined;
  onApply: (preset: SearchPreset) => void;
  onSave: () => void;
  onEdit?: ((preset: SearchPreset) => void) | undefined;
  onDelete?: ((preset: SearchPreset) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const pageActive = usePageActive();
  useLayoutEffect(() => { if (!pageActive) setOpen(false); }, [pageActive]);
  const field = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pointerStartedInPanel = useRef(false);
  // 返回手势先收起这个面板（见 overlayBackGuard）。
  useOverlayBackGuard(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previousFocus = document.activeElement;
    panel?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => {
      if ((document.activeElement === document.body || panel?.contains(document.activeElement)) && previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden]')) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  // The popover closes the way the select fields do. 浮层挂到 body 上以后，面板里的
  // 点击不再算「在 field 里」——那是浮层自己在管的事，这里放过，否则指针一按下按钮
  // 就被卸载，click 永远不会到达它。
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (field.current?.contains(event.target as Node)) return;
      if (target?.closest?.('.search-preset-overlay')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="search-preset-field" ref={field}>
      <button
        type="button"
        className="icon-action search-preset-save"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="检索预设"
        title="检索预设"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
      >
        <BookmarkPlus aria-hidden="true" />
      </button>
      {open && (
        <OverlayLayer>
          <div
            className="search-preset-overlay"
            role="presentation"
            onPointerDownCapture={(event) => { pointerStartedInPanel.current = event.target !== event.currentTarget; }}
            onClick={(event) => {
              if (event.target === event.currentTarget && !pointerStartedInPanel.current) setOpen(false);
              pointerStartedInPanel.current = false;
            }}
          >
            <div
              ref={panelRef}
              className="search-preset-panel"
              role="menu"
              aria-label="检索预设"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
                const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
                let next: number;
                if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
                else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = buttons.length - 1;
                else if (event.key === 'Tab') {
                  event.preventDefault();
                  buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
                  return;
                } else return;
                event.preventDefault(); buttons[next]?.focus();
              }}
            >
              <h2 className="search-preset-title">检索预设</h2>
              {presets && presets.length > 0
                ? presets.map((preset) => (
                  <div className="search-preset-row" role="none" key={preset.presetId}>
                    <button type="button" role="menuitem" className="search-preset-apply" onClick={() => { onApply(preset); setOpen(false); }}>
                      {preset.name}
                    </button>
                    {onEdit && (
                      <button type="button" role="menuitem" className="search-preset-icon" aria-label={`重命名预设 ${preset.name}`} title="重命名预设" onClick={() => { onEdit(preset); setOpen(false); }}>
                        <Pencil aria-hidden="true" />
                      </button>
                    )}
                    {onDelete && (
                      <button type="button" role="menuitem" className="search-preset-icon is-danger" aria-label={`删除预设 ${preset.name}`} title="删除预设" onClick={() => onDelete(preset)}>
                        <Trash2 aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))
                : <p className="search-preset-empty">还没有预设</p>}
              <div className="search-preset-separator" role="none" />
              <button type="button" role="menuitem" className="search-preset-add" onClick={() => { setOpen(false); onSave(); }}>
                <Plus aria-hidden="true" />
                <span>新增预设</span>
              </button>
            </div>
          </div>
        </OverlayLayer>
      )}
    </div>
  );
}
