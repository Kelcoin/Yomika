import { BookmarkPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { SearchPreset } from '../repositories/nativeLibraryRepository';

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
  const field = useRef<HTMLDivElement>(null);

  // The popover closes the way the select fields do.
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!field.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

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
        <div className="search-preset-overlay" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="search-preset-panel"
            role="menu"
            aria-label="检索预设"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
          >
            <h2 className="search-preset-title">检索预设</h2>
            {presets && presets.length > 0
              ? presets.map((preset) => (
                <div className="search-preset-row" role="none" key={preset.presetId}>
                  <button type="button" role="menuitem" className="search-preset-apply" onClick={() => { onApply(preset); setOpen(false); }}>
                    {preset.name}
                  </button>
                  {onEdit && (
                    <button type="button" className="search-preset-icon" aria-label={`重命名预设 ${preset.name}`} title="重命名预设" onClick={() => { onEdit(preset); setOpen(false); }}>
                      <Pencil aria-hidden="true" />
                    </button>
                  )}
                  {onDelete && (
                    <button type="button" className="search-preset-icon is-danger" aria-label={`删除预设 ${preset.name}`} title="删除预设" onClick={() => onDelete(preset)}>
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
      )}
    </div>
  );
}
