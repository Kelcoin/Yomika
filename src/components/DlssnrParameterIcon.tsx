import { SvgIcon } from './SvgIcon';

/** Parameter glyphs share a 24px grid but retain distinct silhouettes. */
export function DlssnrParameterIcon({ kind, selected = false }: { kind: 'style' | 'intensity' | 'tone' | 'structure' | 'skin' | 'mask' | 'ui' | 'light' | 'standard' | 'strong'; selected?: boolean }) {
  const presetFill = selected ? 'currentColor' : 'none';
  const paths = {
    style: <><path d="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" /><circle cx="15.5" cy="8.5" r="1" /></>,
    intensity: <><path d="M5 19a9 9 0 1 1 14 0M12 12l5-5M5 12H3m9-7V3m7 9h2" /><circle cx="12" cy="12" r="2" /></>,
    tone: <><circle cx="12" cy="12" r="8" /><path d="M12 4v16m3-13v10m3-7v4" /></>,
    structure: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
    skin: <><path d="M4 8c3-3 5 3 8 0s5 3 8 0M4 13c3-3 5 3 8 0s5 3 8 0M4 18c3-3 5 3 8 0s5 3 8 0" /><path d="M7 4h.01M17 4h.01" /></>,
    mask: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><path d="M8 9q4-4 8 0v4q-4 6-8 0V9Z" /></>,
    ui: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11m4-5 2 2 4-4" /></>,
    light: <><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.5 5.5l2 2m9 9 2 2m0-13-2 2m-9 9-2 2" /><circle cx="12" cy="12" r="3" fill={presetFill} /></>,
    standard: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" fill={presetFill} /></>,
    strong: <><path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z" fill={presetFill} /><path d="M3 5h3m12 14h3" /></>,
  };
  return <SvgIcon>{paths[kind]}</SvgIcon>;
}
