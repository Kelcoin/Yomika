import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { OverlayLayer } from './OverlayLayer';

type ToastType = 'info' | 'success' | 'error';

/** The three semantic marks, drawn rather than borrowed.
 *
 * A reassurance mark for success, a caution mark for failure, a plain note for
 * information — one 24px grid at the icon weight the rest of the app uses. The
 * previous set came from the general icon library, where the failure mark was a
 * circled cross: 8px from the toast's own close button, it read as a second way
 * to dismiss the message. None of these marks is a cross. */
function ToastMark({ type }: { type: ToastType }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9" />
    {type === 'success' && <path d="M8 12.4l2.7 2.7L16 9.6" />}
    {type === 'error' && <><path d="M12 7.6v5.6" /><path d="M12 16.4h.01" /></>}
    {type === 'info' && <><path d="M12 11.4v5" /><path d="M12 7.6h.01" /></>}
  </svg>;
}
// `| undefined` 是必须的：`exactOptionalPropertyTypes` 开着，可选的 `testId?: string`
// 不许被显式赋成 `undefined`，而调用方（`ComputeWorkerToasts`）永远是整份 meta 一起传。
type ToastAction = { label: string; run: () => void };
type ToastItem = { id: number; text: string; type: ToastType; closing: boolean; testId?: string | undefined; attributes?: Record<string, string> | undefined; action?: ToastAction | undefined };
/** 给需要「在屏幕上留下一个可量读数」的提示用：`testId` 落成 `data-testid`，`attributes`
 * 原样铺到卡片上。§12.3 那条「计算进程掉线后 2 秒内界面上有状态」原来量的是常驻提示条，
 * 现在量的是它换成的那张 toast——同一个选择器，同一个属性（见 `compute-ui-probe.mjs`）。
 *
 * `action` 是给「提示里本来就有一颗按钮」的场景留的（计算进程坏了那颗「重试」）：常驻条删掉
 * 之后，这条路只剩 toast 能承载，而 toast 自己会走，所以按钮也跟着走。 */
export type ToastMeta = { testId?: string | undefined; attributes?: Record<string, string> | undefined; action?: ToastAction | undefined };
type ToastContextValue = {
  showToast: (text: string, type?: ToastType, duration?: number, meta?: ToastMeta) => void;
  clearToasts: (type?: ToastType) => void;
};
const ToastContext = createContext<ToastContextValue | null>(null);
const fallbackToastContext: ToastContextValue = { showToast: () => undefined, clearToasts: () => undefined };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());
  /** 最新一帧的栈。`showToast` 要能看出「这句话是不是已经挂在上面」，而它读不到同一个
   * tick 里刚排进去的那一张（`setItems` 的更新还没落到 state）——所以照 render 的现值记一份。 */
  const itemsRef = useRef<ToastItem[]>([]);
  itemsRef.current = items;
  const closeToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    setItems((current) => current.map((item) => item.id === id ? { ...item, closing: true } : item));
    // Track the removal timer too, otherwise unmounting mid-animation leaves it
    // running and the dismissal timer of a dropped toast is never cleared.
    timers.current.set(id, window.setTimeout(() => {
      timers.current.delete(id);
      setItems((current) => current.filter((item) => item.id !== id));
    }, 220));
  }, []);
  const showToast = useCallback((text: string, type: ToastType = 'info', duration = type === 'error' ? 7000 : 3600, meta?: ToastMeta) => {
    const message = String(text ?? '').trim();
    if (!message) return;
    // 同一句话、同一种颜色已经挂在屏幕上时不叠第二张：它们说的是同一件事（「已连上 X」
    // 会在打开菜单、选中那一行、按「刷新服务」时各说一遍），叠起来像连了两次。重复的这
    // 一次改成把原来那张的计时重新起算，等于「刚刚又确认了一遍」。
    const duplicate = itemsRef.current.find((item) => !item.closing && item.text === message && item.type === type);
    if (duplicate) {
      const timer = timers.current.get(duplicate.id);
      if (timer) window.clearTimeout(timer);
      timers.current.set(duplicate.id, window.setTimeout(() => closeToast(duplicate.id), duration));
      return;
    }
    const id = ++nextId.current;
    const item: ToastItem = { id, text: message, type, closing: false, testId: meta?.testId, attributes: meta?.attributes, action: meta?.action };
    // 同一个 tick 里连着来两句同文时也要看见前一句：ref 跟着一起挪，state 走函数式更新。
    itemsRef.current = [...itemsRef.current, item].slice(-4);
    setItems((current) => [...current, item].slice(-4));
    timers.current.set(id, window.setTimeout(() => closeToast(id), duration));
  }, [closeToast]);
  const clearToasts = useCallback((type?: ToastType) => {
    const removed = itemsRef.current.filter((item) => !type || item.type === type);
    for (const item of removed) {
      const timer = timers.current.get(item.id);
      if (timer) window.clearTimeout(timer);
      timers.current.delete(item.id);
    }
    // Keep deduplication in sync even if a retry emits the same message before
    // React commits the removal in this event.
    itemsRef.current = itemsRef.current.filter((item) => type && item.type !== type);
    setItems(itemsRef.current);
  }, []);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const value = useMemo(() => ({ showToast, clearToasts }), [clearToasts, showToast]);
  // 挂到 body（`OverlayLayer`）：留在页面容器里，容器自己的层叠上下文（`.workspace` 的
  // 入场 transform、列表的 z-index…）会把这个栈关在里面，二级菜单那道 `position: fixed`
  // 的遮罩就会盖在它上面——浮层当初就是因为这个才改用 portal 的，toast 同理。
  return <ToastContext.Provider value={value}>{children}<OverlayLayer><div className="toast-stack" aria-live="polite">
    {items.map((item) => <div className={`toast-card is-${item.type}${item.closing ? ' is-closing' : ''}`} role={item.type === 'error' ? 'alert' : 'status'} data-testid={item.testId} {...item.attributes} key={item.id}>
      <span className="toast-icon" aria-hidden="true"><ToastMark type={item.type} /></span><span className="toast-text">{item.text}</span>{item.action && <button className="toast-action" type="button" onClick={item.action.run}>{item.action.label}</button>}<button className="toast-close" type="button" aria-label="关闭提示" onClick={() => closeToast(item.id)}><X aria-hidden="true" /></button>
    </div>)}
  </div></OverlayLayer></ToastContext.Provider>;
}
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  return value ?? fallbackToastContext;
}
