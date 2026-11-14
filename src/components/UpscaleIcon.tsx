import type { SVGProps } from 'react';
import { StateIcon } from './StateIcon';

/** Neutral uses stay outlined; switches explicitly pass their enabled state. */
export function UpscaleIcon({ enabled = false, ...props }: SVGProps<SVGSVGElement> & { enabled?: boolean }) {
  return <StateIcon {...props} name="sparkles" selected={enabled} />;
}
