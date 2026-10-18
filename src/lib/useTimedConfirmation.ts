import { useEffect, type Dispatch, type SetStateAction } from 'react';

/** Destructive actions share an eight-second confirmation window. */
export function useTimedConfirmation<T>(target: T | undefined, setTarget: Dispatch<SetStateAction<T | undefined>>, busy = false) {
  useEffect(() => {
    if (target === undefined || busy) return;
    const revert = () => setTarget(undefined);
    const timer = window.setTimeout(revert, 8_000);
    const onVisibility = () => { if (document.visibilityState === 'hidden') revert(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', revert);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', revert);
    };
  }, [target, setTarget, busy]);
}
