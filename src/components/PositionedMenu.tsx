import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

/** Pointer/long-press menus share geometry and never lock the page's scrollbar. */
export function PositionedMenu({ at, label, onClose, children }: {
  at: { x: number; y: number };
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return <DropdownMenu.Root modal={false} open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DropdownMenu.Trigger asChild>
      <span aria-hidden="true" style={{ position: 'fixed', left: at.x, top: at.y, width: 0, height: 0 }} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="archive-context-menu" align="start" sideOffset={2} aria-labelledby={undefined} aria-label={label}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
