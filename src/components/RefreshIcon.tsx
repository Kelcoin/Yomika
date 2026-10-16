import { forwardRef, type SVGProps } from 'react';

/** A quiet open ring with a compact arrow, on the app's 24px icon grid. */
export const RefreshIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function RefreshIcon(props, ref) {
  return <svg ref={ref} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M19.4 9A7.8 7.8 0 1 0 19 16" />
    <path d="M19.5 4.5V9H15" />
  </svg>;
});
