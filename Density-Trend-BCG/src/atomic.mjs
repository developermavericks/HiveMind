// Replace a file without readers ever seeing a half-written one. On Windows a rename onto a file another
// process currently has open fails with EPERM/EBUSY, so retry briefly and then fall back to a direct write.
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  for (let attempt = 0; attempt < 10; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleep(20 * (attempt + 1));
    }
  }
  writeFileSync(path, text); // readers tolerate a mid-write file (they keep the previous parse and retry)
}
