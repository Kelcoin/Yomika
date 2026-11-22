import { useCallback, useEffect, useRef, useState } from 'react';

/** A touch sequence belongs to its original DOM target. Retiring that image
 * mid-gesture loses touchend; large texture uploads also compete with motion. */
export function useReaderImageHandover(active: boolean) {
  const [paused, setPaused] = useState(false);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const nativeBusy = useRef(false);
  const canPromote = useCallback(() => !busy.current && !nativeBusy.current, []);
  const setNativeBusy = useCallback((value: boolean) => {
    nativeBusy.current = value;
    setPaused(value || busy.current);
  }, []);
  const pause = useCallback(() => {
    clearTimeout(timer.current);
    busy.current = true;
    setPaused(true);
  }, []);
  const resume = useCallback((delay = 180) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      busy.current = false;
      setPaused(nativeBusy.current);
    }, delay);
  }, []);
  useEffect(() => {
    if (!active) { busy.current = false; nativeBusy.current = false; setPaused(false); }
    return () => clearTimeout(timer.current);
  }, [active]);
  return { paused, canPromote, pause, resume, setNativeBusy };
}
