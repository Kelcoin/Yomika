import { forwardRef, type SVGProps } from 'react';
import { SvgIcon } from './SvgIcon';

/** A quiet open ring with a compact arrow, on the app's 24px icon grid. */
export const RefreshIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function RefreshIcon(props, ref) {
  return <SvgIcon ref={ref} {...props}>
    <path d="M19.4 9A7.8 7.8 0 1 0 19 16" />
    <path d="M19.5 4.5V9H15" />
  </SvgIcon>;
});
