import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadSecret, SecretError } from "../../src/backend/config/secrets.js";

let root: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "signage-secret-test-"));
  directory = join(root, "secrets");
  await mkdir(directory, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function secret(text = '{"token":"synthetic-only"}') {
  await writeFile(join(directory, "weather.json"), text, { mode: 0o600 });
}

test("reads only the requested domain file without requiring the other", async () => {
  await secret();
  expect(await loadSecret("weather", directory)).toEqual({
    token: "synthetic-only",
  });
  await expect(loadSecret("schedule", directory)).rejects.toMatchObject({
    reason: "missing",
  });
});
test("missing directory or file returns a safe error", async () => {
  await expect(loadSecret("weather", directory)).rejects.toMatchObject({
    reason: "missing",
  });
  await expect(
    loadSecret("weather", join(root, "missing")),
  ).rejects.toBeInstanceOf(SecretError);
});
test.each(['{"token":"synthetic-only",', "null", "[]", '"synthetic-only"'])(
  "invalid JSON/object is safe: %s",
  async (text) => {
    await secret(text);
    try {
      await loadSecret("weather", directory);
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretError);
      expect(String(error)).not.toContain("synthetic-only");
      expect(error).not.toHaveProperty("cause");
    }
  },
);
test("rejects a directory in place of a regular secret file", async () => {
  await mkdir(join(directory, "weather.json"));
  await expect(loadSecret("weather", directory)).rejects.toMatchObject({
    reason: "unsafe_path",
  });
});
test.runIf(process.platform === "linux")(
  "accepts exactly 0700 / 0600, rejects permissive modes",
  async () => {
    await secret();
    await expect(loadSecret("weather", directory)).resolves.toEqual({
      token: "synthetic-only",
    });
    for (const mode of [0o644, 0o660, 0o640, 0o4600]) {
      await chmod(join(directory, "weather.json"), mode);
      await expect(loadSecret("weather", directory)).rejects.toMatchObject({
        reason: "permission",
      });
    }
    await chmod(join(directory, "weather.json"), 0o600);
    await chmod(directory, 0o755);
    await expect(loadSecret("weather", directory)).rejects.toMatchObject({
      reason: "permission",
    });
  },
);
test.runIf(process.platform === "linux")(
  "refuses symlinked file, directory, and ancestor",
  async () => {
    await secret();
    await symlink(
      join(directory, "weather.json"),
      join(directory, "schedule.json"),
    );
    await expect(loadSecret("schedule", directory)).rejects.toMatchObject({
      reason: "unsafe_path",
    });
    const alias = join(root, "alias");
    await symlink(directory, alias);
    await expect(loadSecret("weather", alias)).rejects.toMatchObject({
      reason: "unsafe_path",
    });
    const parentAlias = join(root, "parent-alias");
    await symlink(root, parentAlias);
    await expect(
      loadSecret("weather", join(parentAlias, "secrets")),
    ).rejects.toMatchObject({ reason: "unsafe_path" });
  },
);

test.runIf(process.platform === "linux")(
  "rejects a different owner UID",
  async () => {
    await secret();
    const uid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(loadSecret("weather", directory)).rejects.toMatchObject({
        reason: "permission",
      });
    } finally {
      spy.mockRestore();
    }
  },
);
