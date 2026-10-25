import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

export type SecretDomain = "weather" | "schedule";
export const SECRET_DIRECTORY = "/etc/home-digital-signage/secrets";
type Failure =
  | "missing"
  | "permission"
  | "unsafe_path"
  | "invalid_json"
  | "invalid_object"
  | "read_failed";
export class SecretError extends Error {
  constructor(readonly reason: Failure) {
    super(`Secret unavailable: ${reason}`);
    this.name = "SecretError";
  }
}

function permissions(stat: Stats, mode: number) {
  if ((stat.mode & 0o7777) !== mode || stat.uid !== process.getuid!()) {
    throw new SecretError("permission");
  }
}

// Pin every directory with an fd and refuse symlinks, including ancestors.
// Linux /proc/self/fd permits relative traversal without a native openat addon.
async function openLinuxDirectory(path: string): Promise<FileHandle> {
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await open("/", flags);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${handle.fd}/${part}`, flags);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function rejectLinks(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new SecretError("unsafe_path");
  }
}

export async function loadSecret(
  domain: SecretDomain,
  directory = SECRET_DIRECTORY,
): Promise<Record<string, unknown>> {
  let folder: FileHandle | undefined;
  let file: FileHandle | undefined;
  try {
    // Runtime guard as well as the TypeScript union; no caller-supplied filename.
    if (domain !== "weather" && domain !== "schedule")
      throw new SecretError("unsafe_path");
    const path = resolve(directory);
    let filePath: string;
    if (process.platform === "linux") {
      folder = await openLinuxDirectory(path);
      permissions(await folder.stat(), 0o700);
      filePath = `/proc/self/fd/${folder.fd}/${domain}.json`;
    } else {
      await rejectLinks(path);
      filePath = join(path, `${domain}.json`);
      await rejectLinks(filePath);
    }
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink())
      throw new SecretError("unsafe_path");
    file = await open(
      filePath,
      constants.O_RDONLY |
        (process.platform === "linux"
          ? constants.O_NOFOLLOW | constants.O_NONBLOCK
          : 0),
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
      throw new SecretError("unsafe_path");
    if (process.platform === "linux") permissions(stat, 0o600);
    const text = await file.readFile("utf8");
    const after = await file.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new SecretError("unsafe_path");
    if (process.platform !== "linux") {
      await rejectLinks(filePath);
      const current = await lstat(filePath);
      if (
        current.ino !== stat.ino ||
        current.dev !== stat.dev ||
        (await realpath(path)) !== path
      )
        throw new SecretError("unsafe_path");
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new SecretError("invalid_json");
    }
    if (result === null || typeof result !== "object" || Array.isArray(result))
      throw new SecretError("invalid_object");
    // Provider-specific credential schema/authentication belongs to the domain.
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SecretError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new SecretError(
      code === "ENOENT"
        ? "missing"
        : code === "EACCES" || code === "EPERM"
          ? "permission"
          : code === "ELOOP" || code === "ENOTDIR"
            ? "unsafe_path"
            : "read_failed",
    );
  } finally {
    await file?.close().catch(() => undefined);
    await folder?.close().catch(() => undefined);
  }
}
