// Injected at build time by scripts/build.mjs (esbuild `define`). During `tsx`
// dev runs the identifier is undeclared, so `typeof` safely yields "undefined".
declare const __QODER_PROXY_VERSION__: string;

export const VERSION: string =
  typeof __QODER_PROXY_VERSION__ === "string" && __QODER_PROXY_VERSION__ ? __QODER_PROXY_VERSION__ : "0.0.0-dev";
