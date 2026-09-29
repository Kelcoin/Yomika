import { useEffect, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';

import { OverlayLayer } from './OverlayLayer';
import { SettingsRow } from './SettingsRow';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';

/** 设置行背后那套「一行 + 浮层菜单」的控件：选择、数字步进。
 *
 * 原先它们是设置页里的局部组件；DLSSNR 与远端处理两组也要用同一套，就挪出来
 * 导出——外观与行为一字未改。 */

/** The floating menu a row opens. One masked sheet for every kind of control —
 * switches, steppers, option lists, text areas — so the second level always
 * reads as the same thing, wherever it was opened from. Escape belongs to the
 * menu wherever the focus is: it can be lost to the row behind it, and a menu
 * that only answers a focused Escape is a trap. */
export function SettingsMenu({ title, description, icon, onClose, children }: { title: string; description?: string | undefined; icon?: ReactNode; onClose: () => void; children: ReactNode }) {
  // 返回手势先关菜单，而不是把下面的页面带走（见 overlayBackGuard）。
  useOverlayBackGuard(true, onClose);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <OverlayLayer>
      <div className="settings-choice-overlay" role="presentation" onClick={onClose}>
        <div
          className="settings-choice-panel"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
        >
          <h2 className="settings-choice-title">
            {icon && <span className="settings-choice-icon" aria-hidden="true">{icon}</span>}
            {title}
          </h2>
          {description && <p className="settings-menu-desc">{description}</p>}
          <div className="settings-menu-body">{children}</div>
        </div>
      </div>
    </OverlayLayer>
  );
}


/** A setting whose answer is one of a few. */
export function SettingsChoice({ icon, label, hint, ariaLabel, value, options, onChange, optionAction, optionStatus, children }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  ariaLabel?: string | undefined;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  optionAction?: ((option: { value: string; label: string }) => ReactNode) | undefined;
  /** 挂在某一项下面的一行状态（模型下载进度）：它和那一项同处一层，点完就看得见。 */
  optionStatus?: ((option: { value: string; label: string }) => ReactNode) | undefined;
  /** The hidden compat input the tests and the old markup rely on. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <>
      <SettingsRow icon={icon} label={label} hint={hint} value={selected?.label} onClick={() => setOpen(true)} ariaLabel={ariaLabel ?? label} expanded={open} busy={!selected} />
      {children}
      {open && (
        <SettingsMenu title={ariaLabel ?? label} icon={icon} onClose={() => setOpen(false)}>
          <div className="settings-choice-list">
            {options.map((option) => (
              <div className={`settings-choice-option${option.value === value ? ' is-active' : ''}`} key={option.value}>
                <button type="button" className="settings-choice-option-main" onClick={() => { onChange(option.value); setOpen(false); }}>
                  <span>{option.label}</span>
                </button>
                {optionAction?.(option)}
                {optionStatus?.(option)}
              </div>
            ))}
            {options.length === 0 && <p className="settings-choice-empty">暂无可选项</p>}
          </div>
        </SettingsMenu>
      )}
    </>
  );
}

/** A numeric setting, edited with a stepper around the same input the old rows
 * used. Half-typed values still pass through untouched: autosave, not the
 * stepper, decides what is valid. */
export function SettingsNumber({ icon, label, hint, value, min, max, step = 1, format, onChange, disabled }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: ((value: number) => string) | undefined;
  onChange: (value: number) => void;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <>
      {/* A locked number keeps its row but not its affordance: no chevron
          behaviour to press, the value simply sits there until the switch
          above it unlocks. */}
      <SettingsRow icon={icon} label={label} hint={hint} value={format ? format(value) : String(value)} onClick={disabled ? undefined : () => setOpen(true)} ariaLabel={label} expanded={open} disabled={disabled} />
      {open && (
        <SettingsMenu title={label} description={hint} icon={icon} onClose={() => setOpen(false)}>
          <div className="settings-menu-stepper">
            <button className="icon-action" type="button" aria-label={`减小${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}><Minus aria-hidden="true" /></button>
            <input
              className="settings-number"
              aria-label={label}
              type="number"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(event) => onChange(Number(event.target.value))}
            />
            <button className="icon-action" type="button" aria-label={`增大${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}><Plus aria-hidden="true" /></button>
          </div>
        </SettingsMenu>
      )}
    </>
  );
}

/** 关于页里的错误日志：和其他设置项同一套「一行 + 菜单」——行上显示记了几条，点开才读取
 * 列表并给出刷新、导出。行上和菜单里都没有说明文字：那两句（「本次运行记录到的错误；
 * 每次启动重新记录」）既不准确（现在留两轮）又占着最显眼的位置，而下面那行计数已经说清
 * 了状态。 */
