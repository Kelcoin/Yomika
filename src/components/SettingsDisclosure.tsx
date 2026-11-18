import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const SettingsDisclosureContext = createContext(true);

export function SettingsDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const parentOpen = useContext(SettingsDisclosureContext);
  const visible = parentOpen && open;
  return (
    <div className="settings-disclosure" data-open={open} aria-hidden={!visible || undefined} {...(!visible ? { inert: '' } : {})}>
      <div className="settings-disclosure-content">
        <SettingsDisclosureContext.Provider value={visible}>{children}</SettingsDisclosureContext.Provider>
      </div>
    </div>
  );
}

/** Menus are portaled outside the inert settings row. Close them when the row collapses. */
export function useDisclosedSettingsMenu(available = true) {
  const visible = useContext(SettingsDisclosureContext) && available;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);
  return [visible && open, setOpen] as const;
}
