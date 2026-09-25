import type { ReactNode } from 'react';
import { Check, Lock } from 'lucide-react';

/* The controls that are neither a button nor a field, drawn once.
 *
 * A switch and a check row both answer "on or off", but for different shapes of
 * question: a switch is a single setting stated in a row, a check row is one
 * member of a set. Both used to be copy-pasted wherever they were needed — the
 * switch into two files, the check row into three — so every change had to be
 * made three times to stay consistent, and did not always get made. The callers
 * choose the wording now; the drawing lives here.
 */

/** The drawn switch: track, handle, role and checked state.
 *
 * `onToggle` is optional because one caller needs the switch as a picture only.
 * The delete dialog states its option as a sentence with the switch in front of
 * it, and the sentence is the hit target — a handler here as well would toggle
 * twice per click.
 */
export function SwitchControl({ label, checked, disabled, tabIndex, onToggle }: {
  label: string;
  checked: boolean;
  disabled?: boolean | undefined;
  tabIndex?: number | undefined;
  onToggle?: (() => void) | undefined;
}) {
  return (
    <button
      className="switch-control"
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={onToggle}
    ><span /></button>
  );
}

/** A yes/no setting. A switch has no second level to open: the drawn switch
 * sits in the row itself, on the right where every other value lives, and
 * flipping it is the whole interaction. */
export function SettingsSwitch({ icon, label, hint, checked, disabled, onToggle }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onToggle: () => void;
}) {
  return (
    <div className={`settings-row settings-switch-row${disabled ? ' is-disabled' : ''}`}>
      {icon && <span className="settings-row-icon" aria-hidden="true">{icon}</span>}
      <span className="settings-row-copy">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      <SwitchControl label={label} checked={checked} disabled={disabled} onToggle={onToggle} />
    </div>
  );
}

/** One check row: a member of a set, toggled in place. The whole row is the hit
 * target and the control sits at the trailing edge, where every other row's value
 * lives: a **勾选框**（空框 / 填色带勾），不是一枚孤零零的 ✓——勾与不勾都在同一处，
 * 一眼能看出「这里可以勾」，而 ✓ 只在勾上之后才存在，等于什么都不说。
 * `locked` is the member that cannot be turned off (底栏的档案库与设置, 详情页的阅读)
 * — it keeps its tick, shows a lock instead, and is disabled. */
export function CheckRow({ label, checked, locked = false, disabled = false, ariaLabel, onToggle }: {
  label: string;
  checked: boolean;
  locked?: boolean | undefined;
  disabled?: boolean | undefined;
  ariaLabel: string;
  onToggle: () => void;
}) {
  const on = locked || checked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={locked || disabled}
      className={`settings-menu-check${on ? ' is-checked' : ''}${locked ? ' is-pinned' : ''}`}
      onClick={onToggle}
    >
      <span>{label}</span>
      {locked
        ? <Lock aria-hidden="true" />
        : <span className="settings-menu-check-mark" aria-hidden="true">{on && <Check aria-hidden="true" />}</span>}
    </button>
  );
}

/** The set the check rows belong to. One wrapper so every group of them is the
 * same grid and the rows line up across panels.
 *
 * `caption` is for panels that hold **two** groups: spacing alone does not say
 * where one ends and the next begins. The words are the same as the group's
 * accessible name, so the visible copy is hidden from screen readers rather
 * than read out twice. */
export function CheckRowGroup({ label, caption, children }: { label: string; caption?: string | undefined; children: ReactNode }) {
  return (
    <div className="settings-menu-checks" role="group" aria-label={label}>
      {caption && <p className="settings-menu-checks-caption" aria-hidden="true">{caption}</p>}
      {children}
    </div>
  );
}
