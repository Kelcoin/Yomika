import type { SVGProps } from 'react';

/** Three image layers crossing a neural detail grid. */
export function DlssnrIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M4 7.5 12 4l8 3.5-8 3.5-8-3.5Z" />
      <path d="m4 12 8 3.5 8-3.5M4 16.5l8 3.5 8-3.5" />
      <path d="M9 7.5h6M12 6v3" />
    </svg>
  );
}
