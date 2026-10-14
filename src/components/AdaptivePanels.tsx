import { createContext, useContext, type ComponentProps } from 'react';
import { Group as ResizableGroup, Panel as ResizablePanel, Separator as ResizableSeparator } from 'react-resizable-panels';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';

const FlowPanels = createContext(false);

/** Compact pages have one native page scroller. Do not mount the desktop
 * resizer's nested overflow:auto wrappers in the touch hit-test chain. */
export function Group(props: ComponentProps<typeof ResizableGroup>) {
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  return <FlowPanels.Provider value={compact}>{compact
    ? <div className={props.className} data-group style={{ ...props.style, display: 'block', height: 'auto', overflow: 'visible' }}>{props.children}</div>
    : <ResizableGroup {...props} />}</FlowPanels.Provider>;
}

export function Panel(props: ComponentProps<typeof ResizablePanel>) {
  const compact = useContext(FlowPanels);
  return compact
    ? <div id={props.id} className={props.className} data-panel style={{ ...props.style, height: 'auto', maxHeight: 'none', overflow: 'visible' }}>{props.children}</div>
    : <ResizablePanel {...props} />;
}

export function Separator(props: ComponentProps<typeof ResizableSeparator>) {
  const compact = useContext(FlowPanels);
  return compact ? null : <ResizableSeparator {...props} />;
}
