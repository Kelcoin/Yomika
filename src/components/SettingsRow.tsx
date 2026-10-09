import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';

/* The one row shape every setting is built from.
 *
 * It carries no control of its own: an icon, the name and its hint on the left,
 * the current value on the right, and the whole strip opens the floating menu
 * where the actual control lives — the same secondary surface for every kind of
 * setting, which is what keeps the settings page a list instead of a stack of
 * one-off forms.
 *
 * This lives in its own module rather than inside the settings page because the
 * server list needs it too, and importing the page from there would be a cycle.
 */

/** One setting row. A plain value row when there is nothing to open; a button
 * that opens a floating menu otherwise. Nothing in the row is shaped like a
 * field — choosing happens in the menu. */
export function SettingsRow({ icon, label, hint, value, trailing = 'menu', mark, onClick, to, ariaLabel, expanded, busy, disabled, control }: {
  icon?: ReactNode;
  /** A node, not just a string: the server row trails a 「当前」 mark behind the
   * name, and that mark belongs to the label rather than the control slot. */
  label: ReactNode;
  hint?: string | undefined;
  value?: string | undefined;
  /** A short mark behind the name (「有更新」). It rides with the label instead of
   * taking the control slot, which is where the value lives. */
  mark?: ReactNode | undefined;
  trailing?: 'menu' | 'nav' | 'none';
  /** A control of the row's own, sitting where the value would. The one-button
   * settings (模型导入) need their action right here instead of a second level. */
  control?: ReactNode | undefined;
  onClick?: (() => void) | undefined;
  /** 有 `to` 时这一行是路由链接而不是按钮：底栏「更多」页是跳转，不打开面板。 */
  to?: string | undefined;
  ariaLabel?: string | undefined;
  expanded?: boolean | undefined;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  // A node label has no text to fall back on, so callers passing one must name
  // the row themselves — which is what the server row already did. The mark is
  // decoration, so it does not count as a name either.
  const accessibleName = ariaLabel ?? (typeof label === 'string' ? label : undefined);
  const decorated = mark === undefined ? label : <>{label}<span className="settings-row-mark">{mark}</span></>;
  const body = <SettingsRowBody icon={icon} label={decorated} hint={hint} value={value} trailing={trailing} control={control} />;
  const row = to ? (
    <Link className="settings-row settings-row-button" to={to} aria-label={accessibleName}>
      {body}
    </Link>
  ) : onClick ? (
    <button
      className="settings-row settings-row-button"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={accessibleName}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-busy={busy}
    >
      {body}
    </button>
  ) : (
    <div className="settings-row">{body}</div>
  );
  return <div className="settings-item">{row}</div>;
}

/** The three cells of a row, without the row's own element. Exported for the one
 * place that cannot use `SettingsRow`: the server list wraps its row in a Radix
 * trigger, and `asChild` hands the dialog props to whatever the trigger's child
 * is, so the row element there has to be the trigger's own button. */
export function SettingsRowBody({ icon, label, hint, value, trailing, control }: { icon?: ReactNode; label: ReactNode; hint?: string | undefined; value?: string | undefined; trailing: 'menu' | 'nav' | 'none'; control?: ReactNode | undefined }) {
  return (
    <>
      {icon && <span className="settings-row-icon" aria-hidden="true">{icon}</span>}
      <span className="settings-row-copy">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      {/* A supplied control owns the slot outright: the value typography and the
          chevron are for values, and a button next to them would be a third thing
          in the row. */}
      {control ? (
        <span className="settings-row-control">{control}</span>
      ) : (
        <span className="settings-row-control settings-row-value">
          {value && <span>{value}</span>}
          {trailing === 'menu' && <ChevronDown aria-hidden="true" />}
          {trailing === 'nav' && <ChevronRight aria-hidden="true" />}
        </span>
      )}
    </>
  );
}
