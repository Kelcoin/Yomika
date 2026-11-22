import type { SVGProps } from 'react';
import { SvgIcon } from './SvgIcon';

/** Photo and upward arrow, with knockout details in the filled state. */
export function UpscaleIcon({ enabled = false, ...props }: SVGProps<SVGSVGElement> & { enabled?: boolean }) {
  return <SvgIcon data-icon="upscale" data-icon-state={enabled ? 'filled' : 'outline'} {...props}>
    <path className="enhancement-icon-fill" fill="currentColor" fillRule="evenodd" stroke="none"
      d="M5.5 2.25h13a3.25 3.25 0 0 1 3.25 3.25v13a3.25 3.25 0 0 1-3.25 3.25h-13a3.25 3.25 0 0 1-3.25-3.25v-13A3.25 3.25 0 0 1 5.5 2.25Zm4.25 5.25a1.5 1.5 0 1 0-3 0 1.5 1.5 0 1 0 3 0ZM5 17.5 9 13l4 4.5Zm10.25.75v-7l-2 2-1.35-1.35L16.25 7.5l4.35 4.4-1.35 1.35-2-2v7Z" />
    <g className="enhancement-icon-outline">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.25" cy="7.5" r="1.25" />
      <path d="m5 17.5 4-4.5 4 4.5m3.25.75V9m-2.9 2.9 2.9-2.9 2.9 2.9" />
    </g>
  </SvgIcon>;
}
