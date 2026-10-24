/** Parameter glyphs share a 24px grid but retain distinct silhouettes. */
export function DlssnrParameterIcon({ kind }: { kind: 'style' | 'intensity' | 'tone' | 'structure' | 'skin' | 'mask' | 'ui' | 'light' | 'standard' | 'strong' }) {
  const paths = {
    style: <><path d="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" /><circle cx="15.5" cy="8.5" r="1" /></>,
    intensity: <><path d="M5 19a9 9 0 1 1 14 0M12 12l5-5M5 12H3m9-7V3m7 9h2" /><circle cx="12" cy="12" r="2" /></>,
    tone: <><circle cx="12" cy="12" r="8" /><path d="M12 4v16M12 4a8 8 0 0 1 0 16" fill="currentColor" fillOpacity=".25" /></>,
    structure: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
    skin: <><path d="M7 5c0-2 10-2 10 0v7c0 5-3 8-5 9-2-1-5-4-5-9V5Z" /><path d="M9 9h.01M15 9h.01M10 15q2 2 4 0" /></>,
    mask: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><path d="M8 9q4-4 8 0v4q-4 6-8 0V9Z" /></>,
    ui: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11m4-5 2 2 4-4" /></>,
    light: <><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.5 5.5l2 2m9 9 2 2m0-13-2 2m-9 9-2 2" /><circle cx="12" cy="12" r="3" /></>,
    standard: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></>,
    strong: <><path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z" /><path d="M3 5h3m12 14h3" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
