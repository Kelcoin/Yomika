import { Bookmark, BookmarkPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { SearchPreset } from '../repositories/nativeLibraryRepository';

import { SettingsMenu } from './SettingsValueControls';

/** Shared search-preset actions for library and local archives. */
export function SearchPresetField({ presets, onApply, onSave, onEdit, onDelete }: {
  presets?: SearchPreset[] | undefined;
  onApply: (preset: SearchPreset) => void;
  onSave: () => void;
  onEdit?: ((preset: SearchPreset) => void) | undefined;
  onDelete?: ((preset: SearchPreset) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="search-preset-field">
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
        <SettingsMenu title="检索预设" icon={<BookmarkPlus />} role="menu" onClose={() => setOpen(false)}
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
                : (
                  <div className="search-preset-empty" role="none">
                    <span className="search-preset-empty-icon" aria-hidden="true"><Bookmark /></span>
                    <strong>还没有预设</strong>
                    <p>保存当前检索条件，下次可直接套用。</p>
                  </div>
                )}
              {Boolean(presets?.length) && <div className="search-preset-separator" role="none" />}
              <button type="button" role="menuitem" className="search-preset-add" onClick={() => { setOpen(false); onSave(); }}>
                <Plus aria-hidden="true" />
                <span>新增预设</span>
              </button>
        </SettingsMenu>
      )}
    </div>
  );
}
