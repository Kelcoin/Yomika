import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { closeTopOverlay } from './overlayBackGuard';
import { isMobileDevice } from './layoutMode';

export const MOBILE_BACK_EVENT = 'yomika-mobile-back';

export function pageRoot(path: string): string {
  if (path === '/' || path.startsWith('/home/')) return '/';
  const section = path.split('/')[1];
  if (section === 'tools' || section === 'dedup') return '/more';
  return `/${section}`;
}

export class PageBackHistory {
  private pages = new Map<string, string[]>();
  private owner = '/';
  private homeEntries = new Set<string>();

  visit(url: string, returnTo?: string, homeEntry = false, navigationTab = false): void {
    const path = url.split('?')[0]!;
    // Reader/editor routes belong to the page which opened them, even if their
    // route prefix is /library or /reader. Never inherit another tab's stack.
    const leaf = path.startsWith('/reader/') || path.endsWith('/edit');
    const owner = leaf ? (returnTo ? this.ownerFor(returnTo) : this.owner) : pageRoot(path);
    // Home shortcuts open a page excursion; bottom tabs explicitly select an
    // independent workspace and must never inherit that excursion later.
    if (navigationTab || (owner !== this.owner && !homeEntry)) this.homeEntries.delete(owner);
    if (homeEntry && owner !== '/') {
      this.homeEntries.add(owner);
      this.pages.set(owner, [owner]);
    }
    const stack = this.pages.get(owner) ?? [owner];
    const existing = stack.indexOf(url);
    if (existing >= 0) stack.splice(existing + 1);
    else stack.push(url);
    this.pages.set(owner, stack);
    this.owner = owner;
  }

  private ownerFor(url: string): string {
    for (const [owner, stack] of this.pages) if (stack.includes(url)) return owner;
    return pageRoot(url.split('?')[0]!);
  }

  back(): string | undefined {
    const stack = this.pages.get(this.owner);
    if (!stack || stack.length <= 1) {
      if (this.homeEntries.delete(this.owner)) return '/';
      return undefined;
    }
    stack.pop();
    return stack.at(-1);
  }
}

/** Android delivers Back as an app action, not WebView.goBack(): global browser
 * history mixes tabs, filter edits and overlay guards into one confusing stack. */
export function usePageBackNavigation(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const history = useRef(new PageBackHistory());
  const current = useRef({ url: '', state: null as unknown });
  useLayoutEffect(() => {
    const state = location.state as { returnTo?: string; homeEntry?: boolean; navigationTab?: boolean } | null;
    history.current.visit(`${location.pathname}${location.search}`, state?.returnTo, state?.homeEntry, state?.navigationTab);
    current.current = { url: `${location.pathname}${location.search}${location.hash}`, state: window.history.state };
  }, [location]);
  useLayoutEffect(() => {
    const back = (event: Event) => {
      if (closeTopOverlay()) {
        event.preventDefault();
        return;
      }
      const target = history.current.back();
      // Unhandled root Back lets Android's host move the task to the background.
      if (!target) return;
      event.preventDefault();
      navigate(target, { replace: true, state: { routeDirection: -1 } });
    };
    window.addEventListener(MOBILE_BACK_EVENT, back);
    // WKWebView/browser gestures still deliver POP. Stop cross-tab browser
    // history before the router sees it and use the same page-scoped action.
    // Same-URL entries belong to overlay guards and must pass through normally.
    const pop = (event: PopStateEvent) => {
      if (!isMobileDevice()) return;
      const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (url === current.current.url) return;
      event.stopImmediatePropagation();
      window.history.replaceState(current.current.state, '', current.current.url);
      back(event);
    };
    window.addEventListener('popstate', pop, true);
    return () => {
      window.removeEventListener(MOBILE_BACK_EVENT, back);
      window.removeEventListener('popstate', pop, true);
    };
  }, [navigate]);
}
