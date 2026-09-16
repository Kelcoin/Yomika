import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

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
type ToastItem = { id: number; text: string; type: ToastType; closing: boolean };
type ToastContextValue = {
  showToast: (text: string, type?: ToastType, duration?: number) => void;
  clearToasts: (type?: ToastType) => void;
};
const ToastContext = createContext<ToastContextValue | null>(null);
const fallbackToastContext: ToastContextValue = { showToast: () => undefined, clearToasts: () => undefined };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());
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
  const showToast = useCallback((text: string, type: ToastType = 'info', duration = type === 'error' ? 7000 : 3600) => {
    const message = String(text ?? '').trim();
    if (!message) return;
    const id = ++nextId.current;
    setItems((current) => [...current, { id, text: message, type, closing: false }].slice(-4));
    timers.current.set(id, window.setTimeout(() => closeToast(id), duration));
  }, [closeToast]);
  const clearToasts = useCallback((type?: ToastType) => {
    setItems((current) => {
      const removed = current.filter((item) => !type || item.type === type);
      for (const item of removed) {
        const timer = timers.current.get(item.id);
        if (timer) window.clearTimeout(timer);
        timers.current.delete(item.id);
      }
      return current.filter((item) => type && item.type !== type);
    });
  }, []);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const value = useMemo(() => ({ showToast, clearToasts }), [clearToasts, showToast]);
  return <ToastContext.Provider value={value}>{children}<div className="toast-stack" aria-live="polite">
    {items.map((item) => <div className={`toast-card is-${item.type}${item.closing ? ' is-closing' : ''}`} role={item.type === 'error' ? 'alert' : 'status'} key={item.id}>
      <span className="toast-icon" aria-hidden="true"><ToastMark type={item.type} /></span><span className="toast-text">{item.text}</span><button className="toast-close" type="button" aria-label="关闭提示" onClick={() => closeToast(item.id)}><X aria-hidden="true" /></button>
    </div>)}
  </div></ToastContext.Provider>;
}
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  return value ?? fallbackToastContext;
}
