import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { buildApp } from "../../src/backend/app.js";
import { createLogger } from "../../src/backend/logging/logger.js";
import { startBackend } from "../../src/backend/main.js";

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

test("real loopback HTTP on an ephemeral port without external dependencies", async () => {
  const logs = capture();
  const app = buildApp(createLogger("info", logs.stream));
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/ping`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "pong" });
  } finally {
    await app.close();
  }
});

test("request data and raw exceptions never appear in HTTP errors or logs", async () => {
  const marker = "synthetic-secret-DO-NOT-LOG";
  const logs = capture();
  const app = buildApp(createLogger("info", logs.stream));
  app.get("/throw", () => {
    throw new Error(marker);
  });
  try {
    for (const url of [
      `/missing?token=${marker}`,
      `/throw?apiKey=${marker}`,
      `/ping?password=${marker}`,
    ]) {
      const response = await app.inject({
        url,
        headers: { authorization: marker, cookie: marker },
      });
      expect(response.body).not.toContain(marker);
    }
    expect(logs.text()).not.toContain(marker);
    expect(logs.text()).toContain("http_request_failed");
  } finally {
    await app.close();
  }
});

test("Pino redacts supported secret fields and serializes exceptions safely", () => {
  const marker = "synthetic-secret-DO-NOT-LOG";
  const logs = capture();
  const logger = createLogger("info", logs.stream);
  logger.info(
    {
      secret: marker,
      token: marker,
      apiKey: marker,
      password: marker,
      private_key: marker,
      nested: { access_token: marker },
      credentials: { nested: { value: marker } },
      req: { method: "GET", url: marker, headers: { authorization: marker } },
      err: new Error(marker),
    },
    "Safe fixed message",
  );
  expect(logs.text()).not.toContain(marker);
  expect(JSON.parse(logs.text()).service).toBe("backend");
  expect(logs.text()).toContain("[REDACTED]");
});

test("invalid config fails before listening and logs a sanitized ERROR", async () => {
  const logs = capture();
  await expect(
    startBackend({ SIGNAGE_BACKEND_PORT: "secret-marker" }, logs.stream),
  ).rejects.toThrow("Invalid backend configuration");
  const entry = JSON.parse(logs.text());
  expect(entry.event).toBe("config_invalid");
  expect(entry.level).toBe(50);
  expect(logs.text()).not.toContain("secret-marker");
  expect(logs.text()).not.toContain("startup_complete");
});
