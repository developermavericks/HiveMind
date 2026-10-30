// Development launcher: runs `cli.mjs serve` and restarts it whenever a code or config file changes, so the running
// application always reflects the files. Page files (src/ui, dashboard.html) are served fresh on every request, so a browser
// refresh is enough for those; this restarts the server for everything else (.mjs under src/, .json under config/).
//
//   node src/dev.mjs --no-auto        every argument is passed on to `serve`; --no-auto starts it with no scheduled collection
//
// Not for production: use `node src/cli.mjs serve`.
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = ["--no-warnings", join("src", "cli.mjs"), "serve", ...process.argv.slice(2)];
const log = (m) => console.log(`[dev ${new Date().toLocaleTimeString()}] ${m}`);
let child = null, timer = null, restarting = false;

function start() {
  child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  const me = child;
  me.on("exit", (code) => { if (child === me) { child = null; log(`server exited (${code ?? "signal"}); waiting for a change to start it again`); } });
  log(`server started (pid ${me.pid})`);
}
// `serve` may re-launch itself for proxy settings, so the whole process tree is stopped, not just the first process.
function stop() {
  return new Promise((resolve) => {
    const c = child; child = null;
    if (!c || c.exitCode !== null) return resolve();
    c.once("exit", resolve);
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
    setTimeout(resolve, 5000).unref();
  });
}
async function restart(why) {
  if (restarting) return;
  restarting = true;
  log(`${why} changed: restarting`);
  await stop(); await new Promise((r) => setTimeout(r, 400)); start();
  restarting = false;
}
const relevant = (dir, f) => f && ((dir === "src" && extname(f) === ".mjs" && !f.includes("ui")) || (dir === "config" && extname(f) === ".json"));
for (const dir of ["src", "config"]) {
  watch(join(root, dir), { recursive: true }, (_ev, f) => {
    if (!relevant(dir, f)) return;
    clearTimeout(timer); timer = setTimeout(() => restart(`${dir}/${String(f).replace(/\\/g, "/")}`), 600); // editors write a file in several steps
  });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await stop(); process.exit(0); });
start();
