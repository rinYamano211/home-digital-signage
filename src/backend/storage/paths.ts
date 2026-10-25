import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

export class StoragePathError extends Error {
  constructor() {
    super("Unsafe storage path or permission");
  }
}
export function storagePaths(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw new StoragePathError();
  return {
    directory,
    lock: join(directory, "backend.lock"),
    database: join(directory, "signage.db"),
  };
}
export function privateFile(stat: Stats) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o600
  )
    throw new StoragePathError();
}
export function validateDirectory(directory: string) {
  if (process.platform !== "linux") throw new StoragePathError();
  storagePaths(directory);
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new StoragePathError();
    // Root/current-user ancestors only. Sticky root-owned /tmp is permitted for tests.
    if (stat.uid !== 0 && stat.uid !== process.getuid!())
      throw new StoragePathError();
    if ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000))
      throw new StoragePathError();
  }
  const stat = lstatSync(directory);
  if (
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o7777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    throw new StoragePathError();
}
export function validateExistingFile(path: string, optional = false) {
  try {
    privateFile(lstatSync(path));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
export function validateDatabaseFiles(directory: string) {
  const paths = storagePaths(directory);
  validateDirectory(directory);
  validateExistingFile(paths.database);
  for (const suffix of ["-wal", "-shm", "-journal"])
    validateExistingFile(paths.database + suffix, true);
}
if (import.meta.main) {
  try {
    const directory = process.argv[2];
    validateDirectory(directory);
    validateExistingFile(storagePaths(directory).lock, true);
  } catch {
    process.stderr.write("lock: unsafe storage path or permission\n");
    process.exitCode = 74;
  }
}
