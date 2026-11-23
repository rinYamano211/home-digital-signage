import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// Issue #13 (technology-stack 27.4): the API part of the metrics. Prints 30
// CSV fields and never prints `data`.
const script = resolve("scripts/collect-metrics-api.mjs");
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise((done) => server.close(done));
});

type Handler = (path: string) => { status: number; body: string } | null;

async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    const answer = handler(request.url ?? "");
    if (answer === null) return; // never answers
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.body);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function run(base: string, timeoutMs = "3000"): Promise<string[]> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [script],
      {
        env: {
          ...process.env,
          HDS_API_BASE: base,
          HDS_API_TIMEOUT_MS: timeoutMs,
        },
      },
      (error, stdout) =>
        error ? fail(error) : done(stdout.trimEnd().split(",")),
    );
  });
}

const meta = (overrides: Record<string, unknown> = {}) => ({
  dataUpdatedAt: "2026-11-23T01:00:00.000Z",
  expiresAt: "2026-11-23T03:00:00.000Z",
  lastAttemptAt: "2026-11-23T01:10:00.000Z",
  lastAttemptResult: "failure",
  publishedAt: "2026-11-23T01:10:00.000Z",
  dataSource: "cache",
  ...overrides,
});

const states = JSON.stringify({
  schemaVersion: 1,
  states: {
    schedule: {
      data: { events: [{ title: "SECRET-TITLE,with,commas" }] },
      meta: meta({ lastAttemptResult: "success", dataSource: "externalApi" }),
    },
    currentWeather: {
      data: null,
      meta: meta({
        dataUpdatedAt: null,
        expiresAt: null,
        dataSource: null,
      }),
    },
    hourlyWeather: { data: {}, meta: meta() },
    weeklyWeather: { data: {}, meta: meta({ dataSource: "weird,value" }) },
    // rainForecast is omitted (an invalid State is left out of the API).
  },
});

const ok: Handler = (path) =>
  path === "/api/time-availability"
    ? { status: 200, body: '{"availability":"available"}' }
    : { status: 200, body: states };

test("prints checked meta values and never the data", async () => {
  const fields = await run(await serve(ok));
  expect(fields).toHaveLength(30);
  expect(fields[0]).toBe("OK");
  expect(Number(fields[1])).toBeGreaterThanOrEqual(0);
  expect(fields[2]).toBe("available");
  expect(fields[3]).toBe("OK");
  expect(fields.slice(5, 10)).toEqual([
    "2026-11-23T01:10:00.000Z",
    "success",
    "2026-11-23T01:00:00.000Z",
    "2026-11-23T03:00:00.000Z",
    "externalApi",
  ]);
  expect(fields.slice(10, 15)).toEqual([
    "2026-11-23T01:10:00.000Z",
    "failure",
    "null",
    "null",
    "null",
  ]);
  expect(fields[19]).toBe("cache");
  // An unexpected value becomes ERR; an omitted State is ERR.
  expect(fields[24]).toBe("ERR");
  expect(fields.slice(25, 30)).toEqual(["ERR", "ERR", "ERR", "ERR", "ERR"]);
  expect(fields.join(",")).not.toContain("SECRET");
  expect(fields.join(",")).not.toContain("weird");
});

test("records HTTP errors and invalid JSON", async () => {
  const fields = await run(
    await serve((path) =>
      path === "/api/time-availability"
        ? { status: 200, body: '{"availability":"maybe"}' }
        : { status: 503, body: '{"error":"database_unavailable"}' },
    ),
  );
  expect(fields).toHaveLength(30);
  expect([fields[0], fields[2], fields[3]]).toEqual([
    "INVALID_JSON",
    "ERR",
    "HTTP_503",
  ]);
  expect(fields.slice(5)).toEqual(Array(25).fill("ERR"));

  const broken = await run(
    await serve(() => ({ status: 200, body: "not json" })),
  );
  expect([broken[0], broken[3]]).toEqual(["INVALID_JSON", "INVALID_JSON"]);
});

test("records a timeout and a connection error", async () => {
  const silent = await run(await serve(() => null), "200");
  expect([silent[0], silent[3]]).toEqual(["TIMEOUT", "TIMEOUT"]);
  expect(silent).toHaveLength(30);

  // A port that was just closed refuses the connection.
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  const refused = await run(`http://127.0.0.1:${port}`);
  expect([refused[0], refused[3]]).toEqual(["CONN_ERR", "CONN_ERR"]);
  expect(refused).toHaveLength(30);
});
