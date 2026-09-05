/// <reference types="vite/client" />

/** Injected by `define` in vite.config.ts / vitest.config.ts from the version in
 * package.json, so the About page cannot disagree with the shipped build. */
declare const __APP_VERSION__: string;
