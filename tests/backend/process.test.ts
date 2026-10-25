import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.backend.json",
  ]);
}, 30000);

async function reserve() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { server, port: address.port };
}
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
function launch(extra: NodeJS.ProcessEnv) {
  const directory = mkdtempSync(join(tmpdir(), "signage-process-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SIGNAGE_")),
  );
  const child = spawn(
    process.platform === "linux" ? "sh" : process.execPath,
    process.platform === "linux"
      ? ["scripts/with-backend-lock.sh", "backend"]
      : [resolve("dist/backend/main.js")],
    {
      env: { ...env, SIGNAGE_DATA_DIR: directory, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exit = once(child, "exit");
  return { child, exit, output: () => output };
}

test("compiled entry rejects invalid config with nonzero exit and safe logs", async () => {
  const running = launch({ SIGNAGE_BACKEND_PORT: "secret-marker" });
  try {
    const [code] = await running.exit;
    expect(code).toBe(1);
    expect(running.output()).toContain("config_invalid");
    expect(running.output()).not.toContain("secret-marker");
    expect(running.output()).not.toContain("startup_complete");
  } finally {
    if (running.child.exitCode === null) running.child.kill();
  }
});

test.runIf(process.platform === "linux")(
  "compiled entry reports listen conflict and exits nonzero",
  async () => {
    const reservation = await reserve();
    const running = launch({ SIGNAGE_BACKEND_PORT: String(reservation.port) });
    try {
      const [code] = await running.exit;
      expect(code).toBe(1);
      expect(running.output()).toContain("listen_failed");
    } finally {
      if (running.child.exitCode === null) running.child.kill();
      await new Promise<void>((resolve) =>
        reservation.server.close(() => resolve()),
      );
    }
  },
);

test.runIf(process.platform === "linux").each(["SIGTERM", "SIGINT"] as const)(
  "compiled entry serves HTTP and exits cleanly on %s without Secrets",
  async (signal) => {
    const reservation = await reserve();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    const running = launch({ SIGNAGE_BACKEND_PORT: String(reservation.port) });
    try {
      await expect
        .poll(() => running.output(), { timeout: 5000 })
        .toContain("startup_complete");
      const response = await fetch(`http://127.0.0.1:${reservation.port}/ping`);
      expect(await response.json()).toEqual({ message: "pong" });
      running.child.kill(signal);
      const [code, exitSignal] = await running.exit;
      expect(code).toBe(0);
      expect(exitSignal).toBe(null);
      expect(running.output()).toContain("shutdown_complete");
    } finally {
      if (running.child.exitCode === null) running.child.kill("SIGKILL");
    }
  },
);
