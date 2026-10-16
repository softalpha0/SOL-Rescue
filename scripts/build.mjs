import { build } from "esbuild";

await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/plugin.mjs",
  legalComments: "none",
  logLevel: "warning",
  // web3.js pulls in CommonJS packages that call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});