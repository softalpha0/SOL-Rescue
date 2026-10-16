// Assembles vercel-site/: the built page plus the /rpc serverless function.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";

execFileSync(process.execPath, ["scripts/build-web.mjs"], { stdio: "inherit" });
await mkdir("vercel-site", { recursive: true });
// Clear old output but keep .vercel (the link to your Vercel project).
for (const name of await readdir("vercel-site")) {
  if (name !== ".vercel") await rm(`vercel-site/${name}`, { recursive: true, force: true });
}
await cp("web-dist", "vercel-site", { recursive: true });
await cp("vercel", "vercel-site", { recursive: true });
console.log("Built vercel-site/");