import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Dispatch, type SetStateAction, type ButtonHTMLAttributes, type KeyboardEventHandler } from 'react';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { hapticFeedback } from '../lib/haptics';

import { OverlayLayer } from './OverlayLayer';
import { SettingsRow } from './SettingsRow';
import { useDisclosedSettingsMenu } from './SettingsDisclosure';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { usePageActive } from '../app/RetainedPage';

const SettingsMenuContext = createContext<{ setNestedCount: Dispatch<SetStateAction<number>> } | undefined>(undefined);

/** A centred choice with an independent trailing action slot and progress. */
export function SettingsOption({ active, action, status, align = 'center', children, ...buttonProps }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  active?: boolean;
  action?: ReactNode;
  status?: ReactNode;
  align?: 'center' | 'start';
}) {
  return <div className={`settings-choice-option settings-option-row${active ? ' is-active' : ''}`}>
    <button type="button" className={`settings-choice-option-main${align === 'start' ? ' settings-device-option' : ''}`} aria-pressed={active} {...buttonProps}>{children}</button>
    {action && <div className="settings-option-actions">{action}</div>}
    {status}
  </div>;
}

/** A settings row whose secondary content uses the common menu lifecycle. */
export function SettingsPanel({ icon, label, hint, value, ariaLabel, onClose, children }: {
  icon?: ReactNode;
  label: string;
  hint?: string | undefined;
  value?: string | undefined;
  ariaLabel?: string | undefined;
  onClose?: (() => void) | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useDisclosedSettingsMenu();
  const close = () => { setOpen(false); onClose?.(); };
  return <>
    <SettingsRow icon={icon} label={label} hint={hint} value={value} onClick={() => setOpen(true)} ariaLabel={ariaLabel ?? label} expanded={open} />
    {open && <SettingsMenu title={ariaLabel ?? label} icon={icon} onClose={close}>{children}</SettingsMenu>}
  </>;
}

/** 设置行背后那套「一行 + 浮层菜单」的控件：选择、数值滑条。
 *
 * 原先它们是设置页里的局部组件；DLSSNR 与远端处理两组也要用同一套，就挪出来
 * 导出——外观与行为一字未改。 */

/** The floating menu a row opens. One masked sheet for every kind of control —
 * switches, sliders, option lists, text areas — so the second level always
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
export function SettingsMenu({ title, icon, action, onClose, onBack, role = 'dialog', onKeyDown, children }: { title: string; icon?: ReactNode; action?: ReactNode; onClose: () => void; onBack?: (() => void) | undefined; role?: 'dialog' | 'menu'; onKeyDown?: KeyboardEventHandler<HTMLDivElement>; children: ReactNode }) {
  const pageActive = usePageActive();
  const parent = useContext(SettingsMenuContext);
  const [nestedCount, setNestedCount] = useState(0);
  const context = useMemo(() => ({ setNestedCount }), []);
  const back = onBack ?? (parent ? onClose : undefined);
  const dismiss = back ?? onClose;
  const covered = nestedCount > 0;
  useLayoutEffect(() => {
    if (!parent || !pageActive) return;
    parent.setNestedCount((count) => count + 1);
    return () => parent.setNestedCount((count) => count - 1);
  }, [parent, pageActive]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!pageActive || !body || !content || typeof ResizeObserver === 'undefined') return;
    // Measure natural content, never the animated/scroll-constrained viewport:
    // observing the viewport itself would feed every animation frame back in.
    const measure = () => {
      const height = `${content.offsetHeight}px`;
      if (body.style.height !== height) body.style.height = height;
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    observer.observe(content);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [pageActive]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => { if (!pageActive) closeRef.current(); }, [pageActive]);
  // 返回手势先关菜单，而不是把下面的页面带走（见 overlayBackGuard）。
  useOverlayBackGuard(pageActive, dismiss);
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
    if (!pageActive || covered) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) dismiss(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [dismiss, pageActive, covered]);
  if (!pageActive) return null;
  return (
    <OverlayLayer>
      <div className="settings-choice-overlay"
        data-menu-covered={covered || undefined}
        aria-hidden={covered || undefined}
        role="presentation"
        onPointerDownCapture={(event) => { pressOutsideRef.current = event.target === event.currentTarget; }}
        onClick={() => { if (pressOutsideRef.current) dismiss(); }}
      >
        <FocusScope asChild trapped={!covered} loop><div
          className="settings-choice-panel"
          role={role}
          aria-modal={role === 'dialog' ? true : undefined}
          aria-label={title}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.stopPropagation(); dismiss();
            }
          }}
        >
          <SettingsMenuContext.Provider value={context}>
          <h2 className="settings-choice-title" data-has-navigation={Boolean(action) || undefined}>
            {icon && <span className="settings-choice-icon" aria-hidden="true">{icon}</span>}
            {title}
            {action && <span className="settings-choice-action">{action}</span>}
          </h2>
          <div className="settings-menu-body" ref={bodyRef}>
            <div className="settings-menu-content" ref={contentRef}>{children}</div>
          </div>
          </SettingsMenuContext.Provider>
        </div></FocusScope>
      </div>
    </OverlayLayer>
  );
}


/** A setting whose answer is one of a few. */
export function SettingsChoice({ icon, label, hint, ariaLabel, mark, value, options, onChange, optionAction, optionStatus, optionDisabled, children }: {
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
  optionDisabled?: ((option: { value: string; label: string }) => boolean) | undefined;
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
              <SettingsOption key={option.value} active={option.value === value} disabled={optionDisabled?.(option)}
                onClick={() => { onChange(option.value); setOpen(false); }}
                action={optionAction?.(option)} status={optionStatus?.(option)}
              ><span>{option.label}</span></SettingsOption>
            ))}
            {options.length === 0 && <p className="settings-choice-empty">暂无可选项</p>}
          </div>
        </SettingsMenu>
      )}
    </>
  );
}

/** Snap relative to the minimum and remove binary floating-point residue. */
function snapNumber(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(10));
}

/** Shared numeric adjustment: native pointer/keyboard handling, discrete steps,
 * and touch-only selection feedback. */
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
  const [open, setOpen] = useDisclosedSettingsMenu(!disabled);
  return <>
    <SettingsRow icon={icon} label={label} hint={hint} value={format ? format(value) : String(value)} onClick={disabled ? undefined : () => setOpen(true)} ariaLabel={label} expanded={open} disabled={disabled} />
    {open && <SettingsMenu title={label} icon={icon} onClose={() => setOpen(false)}>
      <SettingsNumberSlider label={label} value={value} min={min} max={max} step={step} format={format} onChange={onChange} />
    </SettingsMenu>}
  </>;
}

function SettingsNumberSlider({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  format: ((value: number) => string) | undefined; onChange: (value: number) => void;
}) {
  // Optimistic local rendering keeps the thumb responsive even when the owner
  // persists settings asynchronously. Existing owners debounce their saves.
  const [preview, setPreview] = useState(() => snapNumber(value, min, max, step));
  const lastValue = useRef(preview);
  const touch = useRef(false);
  const dragging = useRef(false);
  const [pressed, setPressed] = useState(false);
  const lastHaptic = useRef(-Infinity);
  useEffect(() => {
    if (dragging.current) return;
    const next = snapNumber(value, min, max, step);
    lastValue.current = next;
    setPreview(next);
  }, [value, min, max, step]);
  const display = (number: number) => format ? format(number) : String(number);
  useEffect(() => {
    if (!pressed) return;
    const finish = () => {
      dragging.current = false;
      touch.current = false;
      setPressed(false);
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
    };
  }, [pressed]);
  const progress = max > min ? (preview - min) / (max - min) * 100 : 0;
  return <div className="settings-number-slider" style={{ '--slider-progress': `${progress}%` } as CSSProperties}>
    <span className="settings-number-limit" aria-hidden="true">{display(min)}</span>
    <div className="settings-number-track" data-pressed={pressed || undefined}>
      <div className="settings-number-travel" aria-hidden="true">
        <div className="settings-number-rail" />
        <span className="settings-number-bubble">{display(preview)}</span>
      </div>
      <input type="range" aria-label={label} aria-valuetext={display(preview)} min={min} max={max} step={step} value={preview}
        onPointerDown={(event) => {
          if (event.button > 0) return;
          dragging.current = true;
          touch.current = event.pointerType === 'touch';
          lastHaptic.current = -Infinity;
          setPressed(true);
        }}
        onBlur={() => { dragging.current = false; touch.current = false; setPressed(false); }}
        onChange={(event) => {
          const next = snapNumber(Number(event.target.value), min, max, step);
          if (next === lastValue.current) return;
          lastValue.current = next;
          setPreview(next);
          if (touch.current && performance.now() - lastHaptic.current >= 50) {
            lastHaptic.current = performance.now();
            hapticFeedback('selection');
          }
          onChange(next);
        }} />
    </div>
    <span className="settings-number-limit" aria-hidden="true">{display(max)}</span>
  </div>;
}

/** 关于页里的错误日志：和其他设置项同一套「一行 + 菜单」——行上显示记了几条，点开才读取
 * 列表并给出刷新、导出。行上和菜单里都没有说明文字：那两句（「本次运行记录到的错误；
 * 每次启动重新记录」）既不准确（现在留两轮）又占着最显眼的位置，而下面那行计数已经说清
 * 了状态。 */
