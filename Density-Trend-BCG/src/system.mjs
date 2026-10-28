// Machine profile: what this computer can actually run. The project is meant to be copied between machines, so
// nothing about hardware is hard-coded. At startup (and on demand) we detect the OS, RAM, GPU/VRAM and whether
// Ollama is installed, recommend a local model that fits, and keep per-machine settings keyed by a machine id, so a
// database or .env copied from another computer never carries over a model that doesn't fit this one.
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const GB = 1024 ** 3;
const run = (cmd, args, timeout = 4000) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch { return null; }
};

export const machineId = () => createHash("sha1").update(`${os.hostname()}|${os.platform()}|${os.arch()}`).digest("hex").slice(0, 10);

// ---- GPUs: prefer vendor tools (accurate VRAM); WMI reports at most 4 GB for any card, so it is only a last resort.
function detectGpus() {
  const gpus = [];
  const nv = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (nv) for (const line of nv.split(/\r?\n/)) { const [name, mb] = line.split(",").map((s) => s.trim()); if (name) gpus.push({ name, vendor: "nvidia", vramGB: Math.round((Number(mb) / 1024) * 10) / 10, source: "nvidia-smi" }); }
  const plat = os.platform();
  if (plat === "darwin") {
    const sp = run("system_profiler", ["SPDisplaysDataType"], 8000) ?? "";
    const name = sp.match(/Chipset Model:\s*(.+)/)?.[1]?.trim();
    if (name && /apple/i.test(name)) gpus.push({ name, vendor: "apple", vramGB: Math.round(((os.totalmem() / GB) * 0.65) * 10) / 10, unified: true, source: "unified memory (≈65% of RAM)" });
  } else if (!gpus.length && plat === "win32") {
    const out = run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.AdapterRAM }"], 8000);
    for (const line of (out ?? "").split(/\r?\n/)) {
      const [name, ram] = line.split("|");
      if (name && !/microsoft basic|remote/i.test(name)) gpus.push({ name: name.trim(), vendor: /nvidia/i.test(name) ? "nvidia" : /amd|radeon/i.test(name) ? "amd" : "intel", vramGB: Math.round((Number(ram) / GB) * 10) / 10 || 0, source: "wmi (may under-report)" });
    }
  } else if (!gpus.length && plat === "linux") {
    const out = run("lspci", []) ?? "";
    for (const l of out.split(/\r?\n/)) if (/vga|3d|display/i.test(l)) gpus.push({ name: l.replace(/^.*?:\s*/, "").slice(0, 80), vendor: /nvidia/i.test(l) ? "nvidia" : /amd|ati/i.test(l) ? "amd" : "intel", vramGB: 0, source: "lspci (VRAM unknown)" });
  }
  return gpus;
}

// ---- Ollama: installed? running? which models?
export async function detectOllama(host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434") {
  host = host.replace(/\/$/, "");
  const version = run("ollama", ["--version"]);
  const info = { installed: !!version, version: version?.replace(/^.*version is\s*/i, "") ?? null, host, reachable: false, models: [] };
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) { info.reachable = true; info.installed = true; info.models = ((await r.json()).models ?? []).map((m) => ({ name: m.name, sizeGB: Math.round((m.size / GB) * 10) / 10 })); }
  } catch { /* not running */ }
  return info;
}

// Models worth offering, smallest to largest (approximate 4-bit download sizes). Structured-JSON quality matters here,
// so these are instruction-tuned families known to follow JSON schemas; anything under ~3B is not good enough.
export const CATALOG = [
  { tag: "qwen2.5:3b-instruct", sizeGB: 1.9, quality: "basic" },
  { tag: "qwen2.5:7b-instruct", sizeGB: 4.7, quality: "good" },
  { tag: "qwen3:8b", sizeGB: 5.2, quality: "good" },
  { tag: "qwen2.5:14b-instruct", sizeGB: 9.0, quality: "very good" },
  { tag: "qwen2.5:32b-instruct", sizeGB: 20, quality: "high" },
  { tag: "llama3.3:70b", sizeGB: 43, quality: "high" },
];

// Pick the largest model that fits fully in GPU memory (fast); otherwise the largest that runs acceptably from RAM.
export function recommendModel(sys) {
  const fastMem = Math.max(0, ...sys.gpus.map((g) => g.vramGB || 0));
  const spareRam = Math.max(0, sys.ramGB - 6); // leave room for the OS and the app
  const fits = (m, mem, factor) => m.sizeGB <= mem * factor;
  const fast = [...CATALOG].reverse().find((m) => fits(m, fastMem, 0.85));
  const cpuCap = sys.ramGB >= 32 ? 14 : 8; // beyond this, CPU/offload inference is too slow to be practical here
  const slow = [...CATALOG].reverse().find((m) => m.sizeGB <= spareRam * 0.7 && m.sizeGB <= cpuCap && m.quality !== "basic");
  let pick, speed, note;
  if (fast && fast.quality !== "basic") { pick = fast; speed = "fast"; note = `Fits in ${fastMem} GB of GPU memory.`; }
  else if (slow) { pick = slow; speed = fastMem >= 3 ? "usable" : "slow"; note = fastMem >= 3 ? `Larger than ${fastMem} GB of VRAM, so it is split between GPU and RAM: works, but expect a few tokens per second.` : "No usable GPU memory: runs on CPU and will be slow."; }
  else { pick = CATALOG[0]; speed = "slow"; note = "This machine is small for local models; a 3B model works for simple labelling only. Prefer a cloud model."; }
  const bigger = CATALOG.filter((m) => m.sizeGB > pick.sizeGB).map((m) => ({ ...m, needs: `${Math.ceil(m.sizeGB / 0.85)} GB of GPU memory to run fast` }));
  return { tag: pick.tag, sizeGB: pick.sizeGB, quality: pick.quality, speed, note, fastMemGB: fastMem, alternatives: CATALOG.filter((m) => m.tag !== pick.tag), tooBig: bigger };
}

// Local inference is far slower than a cloud API and serves one request at a time per GPU.
export const localConcurrency = (sys) => (Math.max(0, ...sys.gpus.map((g) => g.vramGB || 0)) >= 16 ? 3 : Math.max(0, ...sys.gpus.map((g) => g.vramGB || 0)) >= 8 ? 2 : 1);

export function installHint(platform = os.platform()) {
  if (platform === "win32") return { install: "winget install Ollama.Ollama", url: "https://ollama.com/download/windows" };
  if (platform === "darwin") return { install: "brew install ollama   (or download the app)", url: "https://ollama.com/download/mac" };
  return { install: "curl -fsSL https://ollama.com/install.sh | sh", url: "https://ollama.com/download/linux" };
}

let cache = null;
export async function detectSystem({ refresh = false, ollamaHost } = {}) {
  if (cache && !refresh && Date.now() - cache.at < 60_000) return cache.value;
  const cpus = os.cpus();
  const sys = {
    machineId: machineId(), hostname: os.hostname(), os: `${os.type()} ${os.release()}`, platform: os.platform(), arch: os.arch(), node: process.version,
    cpu: { model: cpus[0]?.model?.trim() ?? "unknown", cores: cpus.length }, ramGB: Math.round((os.totalmem() / GB) * 10) / 10, freeRamGB: Math.round((os.freemem() / GB) * 10) / 10,
    gpus: detectGpus(), proxy: { configured: !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY), enabled: process.env.NODE_USE_ENV_PROXY === "1" },
    detectedAt: Date.now(),
  };
  sys.ollama = await detectOllama(ollamaHost);
  sys.recommended = recommendModel(sys);
  sys.localConcurrency = localConcurrency(sys);
  sys.install = installHint(sys.platform);
  cache = { at: Date.now(), value: sys };
  return sys;
}

// Per-machine settings live in the database under this machine's id, so they never leak across computers.
export const machineKey = (k) => `machine.${machineId()}.${k}`;
export function machineSettings(store) { return store.getJson(machineKey("settings"), {}); }
export function saveMachineSettings(store, patch) { const s = { ...machineSettings(store), ...patch }; store.setJson(machineKey("settings"), s); return s; }
