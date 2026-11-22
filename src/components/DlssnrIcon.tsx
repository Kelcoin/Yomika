import type { SVGProps } from 'react';
import { SvgIcon } from './SvgIcon';

/** Scan corners and a diamond highlight suggest detail recovery without resizing. */
export function DlssnrIcon({ enabled = false, ...props }: SVGProps<SVGSVGElement> & { enabled?: boolean }) {
  const sparkle = 'M12 5.7 13.85 10.15 18.3 12 13.85 13.85 12 18.3 10.15 13.85 5.7 12 10.15 10.15Z';
  return <SvgIcon data-icon="dlssnr" data-icon-state={enabled ? 'filled' : 'outline'} {...props}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3m-8 0H5a2 2 0 0 1-2-2v-3" />
    <path className="enhancement-icon-fill" d={sparkle} fill="currentColor" stroke="none" />
    <path d={sparkle} />
  </SvgIcon>;
}
