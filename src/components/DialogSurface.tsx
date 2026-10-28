import * as Dialog from '@radix-ui/react-dialog';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

/** One portal, backdrop and panel for every ordinary app dialog. Root/Trigger
 * remain with callers so their busy, validation and confirmation rules survive. */
export const DialogSurface = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Dialog.Content>>(
  function DialogSurface({ className, children, ...props }, ref) {
    return <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content ref={ref} className={`dialog-content${className ? ` ${className}` : ''}`} {...props}>
        {children}
      </Dialog.Content>
    </Dialog.Portal>;
  },
);

export function DialogHeading({ icon, hidden = false, children }: { icon?: ReactNode; hidden?: boolean; children: ReactNode }) {
  return <Dialog.Title className={hidden ? 'visually-hidden' : 'dialog-title'}>{icon}{children}</Dialog.Title>;
}
