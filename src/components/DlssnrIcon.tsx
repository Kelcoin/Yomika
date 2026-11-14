import type { SVGProps } from 'react';
import { SvgIcon } from './SvgIcon';

/** Layered reconstruction: outline when neutral/off, solid layers when on. */
export function DlssnrIcon({ enabled = false, ...props }: SVGProps<SVGSVGElement> & { enabled?: boolean }) {
  return <SvgIcon data-icon="dlssnr" data-icon-state={enabled ? 'filled' : 'outline'} {...props}>
    {enabled
      ? <path d="m 2.1 6.268 9.9 -4.168 9.9 4.168 -9.9 4.168 -9.9 -4.168 Z m 0 4.168 9.9 4.168 9.9 -4.168 v 3.126 l -9.9 4.168 -9.9 -4.168 v -3.126 Z m 0 7.295 v -2.084 l 9.9 4.168 9.9 -4.168 v 2.084 l -9.9 4.168 -9.9 -4.168 Z" fill="currentColor" stroke="none" />
      : <path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" />}
  </SvgIcon>;
}
