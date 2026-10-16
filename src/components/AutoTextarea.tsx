import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      element.style.height = 'auto';
      const style = getComputedStyle(element);
      const minimum = parseFloat(style.minHeight) || 88;
      const maximum = Math.max(minimum, Math.min(480, window.innerHeight * .5));
      const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      element.style.height = `${Math.max(minimum, Math.min(maximum, element.scrollHeight + borders))}px`;
      element.style.overflowY = element.scrollHeight + borders > maximum ? 'auto' : 'hidden';
    };
    fit();
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (width === element.clientWidth) return;
      width = element.clientWidth;
      fit();
    });
    observer?.observe(element);
    element.addEventListener('input', fit);
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); element.removeEventListener('input', fit); window.removeEventListener('resize', fit); };
  }, [props.value, props.defaultValue]);
  return <textarea {...props} ref={ref} style={{ ...props.style, resize: 'none' }} />;
}
