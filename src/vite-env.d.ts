/// <reference types="vite/client" />

/** Injected by `define` in vite.config.ts / vitest.config.ts from the version in
 * package.json, so the About page cannot disagree with the shipped build. */
declare const __APP_VERSION__: string;
/** From package.json at build time, so the About page has one source for them.
 * `license` is empty until the project declares one; the row is then not shown. */
declare const __APP_AUTHOR__: string;
declare const __APP_LICENSE__: string;
declare const __APP_REPOSITORY__: string;
