import { fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { privateFile, storagePaths, validateDirectory } from "./paths.js";

export const LOCK_FD = 9;
export class LockError extends Error {
  constructor() {
    super("Exclusive storage lock required");
  }
}
// Only this factory issues a capability. Every DB open rechecks the kernel FD.
export class ExclusiveLock {
  private constructor(readonly directory: string) {}
  static inherited(directory: string): ExclusiveLock {
    const lock = new ExclusiveLock(directory);
    lock.assertHeld();
    return lock;
  }
  assertHeld(): void {
    try {
      validateLockDescriptor(this.directory);
      const info = readFileSync(`/proc/self/fdinfo/${LOCK_FD}`, "utf8");
      if (!/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+.*\s0 EOF$/m.test(info))
        throw new LockError();
    } catch {
      throw new LockError();
    }
  }
}
// Do not close this FD while Node is alive, and never forward it via child stdio.
// Node child_process defaults close non-stdio FDs; tests verify that behavior.

// Check the opened object before flock as well as after exec/before DB access.
export function validateLockDescriptor(directory: string) {
  validateDirectory(directory);
  const path = storagePaths(directory).lock;
  const fd = fstatSync(LOCK_FD);
  const named = lstatSync(path);
  privateFile(fd);
  privateFile(named);
  if (
    fd.dev !== named.dev ||
    fd.ino !== named.ino ||
    realpathSync(`/proc/self/fd/${LOCK_FD}`) !== path
  )
    throw new LockError();
}
if (import.meta.main) {
  try {
    validateLockDescriptor(process.argv[2]);
  } catch {
    process.stderr.write("lock: unsafe opened descriptor\n");
    process.exitCode = 74;
  }
}
