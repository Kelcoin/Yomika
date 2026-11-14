import { forwardRef, type SVGProps } from 'react';

/** Shared geometry for functional icons. Branding and progress diagrams keep
 * their own coordinate systems; controls use this 24px, rounded 1.75px grid. */
export const SvgIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function SvgIcon({ children, className, ...props }, ref) {
  return <svg ref={ref} className={`app-icon${className ? ` ${className}` : ''}`} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{children}</svg>;
});
