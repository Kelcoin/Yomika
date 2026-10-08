import { useEffect, useRef, useState, type ReactNode } from 'react';
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
 * that only answers a focused Escape is a trap.
 *
 * 菜单里只有标题（图标 + 文字）和内容：标题下面那行灰色小字（`description`）
 * 统一去掉了——它把同一句话在行上、菜单里说了两遍，还把内容区往下压了一截，
 * 每个二级菜单顶上都是它。行里的 hint 留着，那是列表该说的话。
 *
 * 标记上有一条不能动的形状：`<OverlayLayer>` 后面紧跟着
 * `<div className="settings-choice-overlay"`，中间不夹别的节点或注释——
 * tests/design-system-contract.test.ts 用这个形状认「浮层挂到 body」这条合同。
 *
 * `action` 是给「菜单自己的动作」留的口子（层参数说明的问号就是这样进来的）：
 * 它钉在标题行右端，因为标题行是这一屏里唯一一条横跨整个面板、又只属于菜单的
 * 条带。放进内容区就得为它单开一行，而那行会跟着内容一起滚走。 */
export function SettingsMenu({ title, icon, action, onClose, children }: { title: string; icon?: ReactNode; action?: ReactNode; onClose: () => void; children: ReactNode }) {
  // 返回手势先关菜单，而不是把下面的页面带走（见 overlayBackGuard）。
  useOverlayBackGuard(true, onClose);
  /** 「点外面关闭」判定的是按下的落点，不是那次 click 的落点。
   *
   * 面板里的 textarea 自带右下角的缩放柄：按下在面板里，松开时指针已经在面板外。浏览器
   * 仍会为这一对补一次 click，落点是按下与松开的**最近公共祖先**——面板外的最近祖先就是
   * 遮罩本身，于是这次 click 和「在遮罩上点一下」完全同形，菜单会在人只是拉了一下输入框
   * 的时候关掉。所以这里记住按下时落在哪里：按下在面板里（target 不是遮罩自己）就不是点
   * 外面，后面那次 click 不关；真的在遮罩上按下、又在遮罩上松开的照旧关。
   *
   * 用捕获阶段（`onPointerDownCapture`）：菜单里的控件有人在 pointerdown 上
   * `stopPropagation` 也不会让遮罩看不到这一次按下。 */
  const pressOutsideRef = useRef(true);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <OverlayLayer>
      <div className="settings-choice-overlay"
        role="presentation"
        onPointerDownCapture={(event) => { pressOutsideRef.current = event.target === event.currentTarget; }}
        onClick={() => { if (pressOutsideRef.current) onClose(); }}
      >
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
            {action && <span className="settings-choice-action">{action}</span>}
          </h2>
          <div className="settings-menu-body">{children}</div>
        </div>
      </div>
    </OverlayLayer>
  );
}


/** A setting whose answer is one of a few. */
export function SettingsChoice({ icon, label, hint, ariaLabel, mark, value, options, onChange, optionAction, optionStatus, children }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  ariaLabel?: string | undefined;
  /** 名字旁的一枚小签（「有更新」这类）。它属于**名称**，不是控件槽：行尾那一格
   * 放的是当前值，而这里要说的是「这个设置项里有东西该换了」——打开菜单之前就该
   * 看得见，所以不放在菜单里的选项行上。 */
  mark?: ReactNode | undefined;
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
      <SettingsRow
        icon={icon}
        label={mark === undefined ? label : <>{label}<span className="settings-row-mark">{mark}</span></>}
        hint={hint}
        value={selected?.label}
        onClick={() => setOpen(true)}
        /* 名称带上小签之后 `label` 是个节点，行自己读不出可访问名——这里必须点名。 */
        ariaLabel={ariaLabel ?? label}
        expanded={open}
        busy={!selected}
      />
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

/** 步进按钮的结果要不要吸掉浮点残渣：`1.1 + 0.05` 在 IEEE754 下是
 * `1.1500000000000001`，`1.1 + 0.1` 是 `1.2000000000000002`——用户按一下就真的在
 * 输入框里读到这一串。
 *
 * 位数取「参与运算的两个数里小数位更多的那个」，所以它只消残渣，不会把用户手敲的
 * 1.125 吸到 0.1 的网格上；12 位上限是给旧版本已经写坏的值留的后路
 * （`1.1500000000000001 + 0.1` 该收成 1.25，而不是继续带着尾巴走）。输入框本身仍然
 * 原样透传：半途的值归 autosave 判断，不归步进。 */
function steppedValue(value: number, step: number, direction: 1 | -1): number {
  const next = value + direction * step;
  if (!Number.isFinite(next)) return next;
  const decimals = Math.min(12, Math.max(decimalPlaces(value), decimalPlaces(step)));
  return Number(next.toFixed(decimals));
}

/** 十进制写法里的小数位数。`1e-7` 这类指数写法落回 0 位：本应用的步进量级到不了
 * 那里，真到了也只是少吸一位。 */
function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
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
        <SettingsMenu title={label} icon={icon} onClose={() => setOpen(false)}>
          <div className="settings-menu-stepper">
            <button className="icon-action" type="button" aria-label={`减小${label}`} disabled={value <= min} onClick={() => onChange(clamp(steppedValue(value, step, -1)))}><Minus aria-hidden="true" /></button>
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
            <button className="icon-action" type="button" aria-label={`增大${label}`} disabled={value >= max} onClick={() => onChange(clamp(steppedValue(value, step, 1)))}><Plus aria-hidden="true" /></button>
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
