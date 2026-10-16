import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("web-dist", { recursive: true });
await build({
  entryPoints: ["web/app.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "web-dist/app.js",
  inject: ["web/buffer-shim.ts"],
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
await copyFile("web/index.html", "web-dist/index.html");
console.log("Built web-dist/ \u2014 run `pnpm web` and open http://localhost:5173");