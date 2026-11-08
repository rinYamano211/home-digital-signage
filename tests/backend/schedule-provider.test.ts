// Issue #10 Google Calendar Provider with a fake ctx.http (technology-stack
// 18.7). Synthetic RSA key and responses only; no network, no real Secret.
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AcquireContext,
  AcquireResult,
} from "../../src/backend/acquisition/coordinator.js";
import type {
  HttpAdapterConfig,
  HttpOutcome,
} from "../../src/backend/http/outcome.js";
import {
  CALENDAR_SCOPE,
  serviceAccount,
  TOKEN_URL,
  TokenCache,
} from "../../src/backend/schedule/google-auth.js";
import {
  createScheduleProvider,
  SCHEDULE_PERIOD_MS,
} from "../../src/backend/schedule/provider.js";
import { scheduleProvider } from "../../src/backend/schedule/setup.js";
import { SecretError } from "../../src/backend/config/secrets.js";
import type { BackendConfig } from "../../src/backend/config/schema.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const EMAIL = "signage-test@synthetic.example.test";
const CALENDAR = "synthetic-calendar-id@example.test";
const TOKEN = "synthetic-access-token-value";
const secret = () => ({
  type: "service_account",
  client_email: EMAIL,
  private_key: PEM,
  private_key_id: "synthetic",
});
const account = () => serviceAccount(secret())!;

let wall = 0;
beforeEach(() => {
  wall = Date.parse("2026-11-08T01:00:00Z"); // 10:00 JST
  vi.spyOn(Date, "now").mockImplementation(() => wall);
});
afterEach(() => vi.restoreAllMocks());

const json = (v: unknown, status = 200, retryAfter?: string): HttpOutcome => ({
  kind: "response",
  http: { status, ...(retryAfter ? { retryAfter } : {}) },
  body: new TextEncoder().encode(JSON.stringify(v)),
});
const tokenOk = () => json({ access_token: TOKEN, expires_in: 3600 });
const event = (id: string) => ({
  id,
  summary: `title-${id}`,
  start: { dateTime: "2026-11-08T09:00:00+09:00" },
  end: { dateTime: "2026-11-08T10:00:00+09:00" },
});
function fixture() {
  const logs: unknown[] = [];
  const logger = {
    debug: (o: unknown) => logs.push(["debug", o]),
    info: (o: unknown) => logs.push(["info", o]),
    warn: (o: unknown) => logs.push(["warn", o]),
  } as unknown as Parameters<typeof createScheduleProvider>[0]["logger"];
  const provider = createScheduleProvider({
    calendarId: CALENDAR,
    account: account(),
    logger,
  });
  const requests: HttpAdapterConfig[] = [];
  const queue: (HttpOutcome | (() => HttpOutcome))[] = [];
  const abort = new AbortController();
  const ctx = (): AcquireContext => ({
    startedAt: new Date(wall).toISOString(),
    signal: abort.signal,
    http: async (config) => {
      requests.push(config);
      const next = queue.shift();
      if (!next) throw new Error("unexpected request");
      return typeof next === "function" ? next() : next;
    },
  });
  const run = () => provider.acquire(ctx());
  return { provider, logs, requests, queue, abort, run };
}
const noSecrets = (logs: unknown[]) => {
  const text = JSON.stringify(logs);
  for (const s of [CALENDAR, TOKEN, EMAIL, "PRIVATE KEY", "title-"])
    expect(text).not.toContain(s);
};

test("serviceAccount validates the Secret shape and RSA key", () => {
  expect(account().clientEmail).toBe(EMAIL);
  const ec = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  for (const bad of [
    { ...secret(), type: "authorized_user" },
    { ...secret(), client_email: "no-at-sign" },
    { ...secret(), client_email: 1 },
    { ...secret(), private_key: "-----BEGIN PRIVATE KEY-----\nbroken" },
    { ...secret(), private_key: ec },
    {},
  ])
    expect(serviceAccount(bad)).toBeNull();
});

test("token request: RS256 JWT Bearer assertion verifiable with the public key", async () => {
  const f = fixture();
  f.queue.push(tokenOk(), json({ items: [] }));
  await f.run();
  const post = f.requests[0]!;
  expect(post).toMatchObject({ url: TOKEN_URL, method: "POST" });
  const form = new URLSearchParams(post.body);
  expect(form.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const [h, c, s] = form.get("assertion")!.split(".");
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  const iat = Math.floor(wall / 1000);
  expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
    iss: EMAIL,
    scope: CALENDAR_SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  });
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${c}`),
      keys.publicKey,
      Buffer.from(s!, "base64url"),
    ),
  ).toBe(true);
});

test("success: all pages, Authorization header, normalized data and 6 h TTL", async () => {
  const f = fixture();
  f.queue.push(
    tokenOk(),
    json({ items: [event("a")], nextPageToken: "p2" }),
    json({ items: [event("b"), { id: "c", status: "cancelled" }] }),
  );
  const result = await f.run();
  expect(result).toEqual({
    kind: "success",
    data: {
      date: "2026-11-08",
      events: ["a", "b"].map((id) => ({
        id,
        title: `title-${id}`,
        allDay: false,
        startAt: "2026-11-08T00:00:00.000Z",
        endAt: "2026-11-08T01:00:00.000Z",
      })),
    },
    expiresAt: new Date(wall + 6 * 3_600_000).toISOString(),
  });
  expect(f.requests.slice(1).map((r) => r.headers)).toEqual([
    { authorization: `Bearer ${TOKEN}` },
    { authorization: `Bearer ${TOKEN}` },
  ]);
  expect(new URL(f.requests[2]!.url).searchParams.get("pageToken")).toBe("p2");
  expect(f.requests[1]!.method).toBeUndefined();
  noSecrets(f.logs);
});

test("an empty day is a normal success with events []", async () => {
  const f = fixture();
  f.queue.push(tokenOk(), json({}));
  expect(await f.run()).toMatchObject({
    kind: "success",
    data: { date: "2026-11-08", events: [] },
  });
});

test("the token is reused until 60 s before expiry, then requested again", async () => {
  const f = fixture();
  f.queue.push(tokenOk(), json({}));
  await f.run();
  wall += 3600_000 - 60_001;
  f.queue.push(json({}));
  await f.run();
  expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  wall += 1;
  f.queue.push(tokenOk(), json({}));
  await f.run();
  expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(2);
});

test("401 from the Calendar API clears the token; no re-auth in the same attempt", async () => {
  const f = fixture();
  f.queue.push(tokenOk(), json({}, 401));
  expect(await f.run()).toEqual({ kind: "failure", httpStatus: 401 });
  expect(f.requests).toHaveLength(2);
  f.queue.push(tokenOk(), json({}));
  await f.run();
  expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(2);
  expect(f.logs).toContainEqual([
    "warn",
    {
      event: "schedule_acquisition_failed",
      reason: "auth_failed",
      httpStatus: 401,
    },
  ]);
});

const failures: [string, HttpOutcome[], AcquireResult, string][] = [
  [
    "token 400",
    [json({ error: "invalid_grant" }, 400)],
    { kind: "failure", httpStatus: 400 },
    "auth_failed",
  ],
  [
    "token body invalid",
    [json({ token: "x" })],
    { kind: "failure" },
    "auth_failed",
  ],
  [
    "token 429",
    [json({}, 429, "120")],
    { kind: "failure", httpStatus: 429, retryAfter: "120" },
    "rate_limited",
  ],
  [
    "events 403",
    [tokenOk(), json({}, 403)],
    { kind: "failure", httpStatus: 403 },
    "forbidden",
  ],
  [
    "events 404",
    [tokenOk(), json({}, 404)],
    { kind: "failure", httpStatus: 404 },
    "forbidden",
  ],
  [
    "events 429",
    [tokenOk(), json({}, 429, "900")],
    { kind: "failure", httpStatus: 429, retryAfter: "900" },
    "rate_limited",
  ],
  [
    "events 503",
    [tokenOk(), json({}, 503)],
    { kind: "failure", httpStatus: 503 },
    "server_error",
  ],
  [
    "events 400",
    [tokenOk(), json({}, 400)],
    { kind: "failure", httpStatus: 400 },
    "http_error",
  ],
  [
    "events timeout",
    [tokenOk(), { kind: "timeout" }],
    { kind: "failure" },
    "timeout",
  ],
  [
    "events network",
    [tokenOk(), { kind: "network_error" }],
    { kind: "failure" },
    "network_error",
  ],
  [
    "events too large",
    [tokenOk(), { kind: "body_too_large", http: { status: 200 } }],
    { kind: "failure", httpStatus: 200 },
    "invalid_response",
  ],
  [
    "events malformed",
    [tokenOk(), json({ items: [{ summary: "no id" }] })],
    { kind: "failure" },
    "invalid_response",
  ],
  [
    "event invalid",
    [tokenOk(), json({ items: [{ id: "a", start: {}, end: {} }] })],
    { kind: "failure" },
    "invalid_response",
  ],
];
test.each(failures)(
  "%s is a failure classified for the log only",
  async (_name, responses, expected, reason) => {
    const f = fixture();
    f.queue.push(...responses);
    expect(await f.run()).toEqual(expected);
    expect(f.logs).toContainEqual([
      "warn",
      expect.objectContaining({ event: "schedule_acquisition_failed", reason }),
    ]);
    noSecrets(f.logs);
  },
);

test("a failure in page 2 publishes no partial data", async () => {
  const f = fixture();
  f.queue.push(
    tokenOk(),
    json({ items: [event("a")], nextPageToken: "p2" }),
    json({}, 500),
  );
  expect(await f.run()).toEqual({ kind: "failure", httpStatus: 500 });
});

test("more than 10 pages fails the attempt", async () => {
  const f = fixture();
  f.queue.push(tokenOk());
  for (let i = 0; i < 10; i++)
    f.queue.push(json({ items: [], nextPageToken: `p${i}` }));
  expect(await f.run()).toEqual({ kind: "failure" });
  expect(f.requests).toHaveLength(11);
  expect(f.logs).toContainEqual([
    "warn",
    { event: "schedule_acquisition_failed", reason: "invalid_response" },
  ]);
});

test("the JST date rolling forward during the attempt discards the result", async () => {
  wall = Date.parse("2026-11-08T14:59:59Z"); // 23:59:59 JST
  const f = fixture();
  f.queue.push(tokenOk(), () => {
    wall += 3000; // completes at 00:00:02 JST
    return json({ items: [event("a")] });
  });
  expect(await f.run()).toEqual({ kind: "discard" });
  expect(f.logs).toContainEqual([
    "info",
    { event: "schedule_result_discarded", reason: "date_rolled_over" },
  ]);
});

test("the clock moving back across midnight is a failure (Backoff)", async () => {
  wall = Date.parse("2026-11-08T15:00:01Z"); // 00:00:01 JST on 11/09
  const f = fixture();
  f.queue.push(tokenOk(), () => {
    wall -= 5000;
    return json({});
  });
  expect(await f.run()).toEqual({ kind: "failure" });
  expect(f.logs).toContainEqual([
    "warn",
    { event: "schedule_acquisition_failed", reason: "clock_moved_back" },
  ]);
});

test("an aborted attempt is not logged, caches no token and requests no next page", async () => {
  const f = fixture();
  f.queue.push(() => {
    f.abort.abort();
    return tokenOk();
  });
  expect(await f.run()).toEqual({ kind: "failure" });
  expect(f.requests).toHaveLength(1);
  expect(f.logs).toEqual([]);
  // Not cached: a later attempt requests a token again.
  const g = fixture();
  g.queue.push(tokenOk(), json({ items: [], nextPageToken: "p2" }), () => {
    g.abort.abort();
    return { kind: "aborted" };
  });
  expect(await g.run()).toEqual({ kind: "failure" });
  expect(g.logs).toEqual([]);
});

test("nextPeriodMs caps the success period at the next JST midnight", () => {
  const { provider } = fixture();
  expect(provider.nextPeriodMs!(Date.parse("2026-11-08T14:55:00Z"))).toBe(
    300_000,
  );
  expect(provider.nextPeriodMs!(Date.parse("2026-11-08T14:59:59Z"))).toBe(1000);
  expect(provider.nextPeriodMs!(Date.parse("2026-11-08T15:00:00Z"))).toBe(
    SCHEDULE_PERIOD_MS,
  );
  expect(provider).toMatchObject({ stateKey: "schedule", quota: false });
});

test("TokenCache refresh margin", () => {
  const cache = new TokenCache();
  cache.set("t", 0, 120_000);
  expect(cache.get(59_999)).toBe("t");
  expect(cache.get(60_000)).toBeNull();
  cache.clear();
  expect(cache.get(0)).toBeNull();
});

const config = (id?: string) =>
  ({
    dataDirectory: "/tmp",
    host: "127.0.0.1",
    port: 3000,
    logLevel: "info",
    shutdownTimeoutMs: 10000,
    ...(id === undefined ? {} : { scheduleCalendarId: id }),
  }) as BackendConfig;
test.each([
  ["unset ID", undefined, async () => secret(), "calendar_id_unset"],
  [
    "missing Secret",
    CALENDAR,
    async () => {
      throw new SecretError("missing");
    },
    "missing",
  ],
  [
    "unsafe Secret path",
    CALENDAR,
    async () => {
      throw new SecretError("unsafe_path");
    },
    "unsafe_path",
  ],
  [
    "unexpected error",
    CALENDAR,
    async () => {
      throw new Error(PEM);
    },
    "read_failed",
  ],
  [
    "invalid key",
    CALENDAR,
    async () => ({ ...secret(), private_key: "x" }),
    "invalid_credentials",
  ],
] as const)(
  "setup: %s disables only the Schedule Provider",
  async (_name, id, load, reason) => {
    const logs: unknown[] = [];
    const logger = {
      debug: () => {},
      info: (o: unknown) => logs.push(o),
      warn: (o: unknown) => logs.push(o),
    } as unknown as Parameters<typeof scheduleProvider>[1];
    expect(await scheduleProvider(config(id), logger, load)).toBeNull();
    expect(logs).toEqual([{ event: "schedule_provider_disabled", reason }]);
    noSecrets(logs);
  },
);

test("setup: a usable Secret registers the Schedule Provider", async () => {
  const logs: unknown[] = [];
  const logger = {
    debug: () => {},
    info: (o: unknown) => logs.push(o),
    warn: (o: unknown) => logs.push(o),
  } as unknown as Parameters<typeof scheduleProvider>[1];
  const load = vi.fn(async () => secret());
  const provider = await scheduleProvider(config(CALENDAR), logger, load);
  expect(provider).toMatchObject({ stateKey: "schedule" });
  expect(load).toHaveBeenCalledExactlyOnceWith("schedule");
  expect(logs).toEqual([{ event: "schedule_provider_enabled" }]);
});

test("Abort right after the last page response: no success / discard log, no result", async () => {
  const f = fixture();
  f.queue.push(tokenOk(), () => {
    f.abort.abort(); // Shutdown while the final response is delivered
    return json({ items: [event("a")] });
  });
  expect(await f.run()).toEqual({ kind: "failure" });
  expect(f.logs).toEqual([]);
  // Also across midnight: no discard log either.
  wall = Date.parse("2026-11-08T14:59:59Z");
  const g = fixture();
  g.queue.push(tokenOk(), () => {
    wall += 3000;
    g.abort.abort();
    return json({ items: [event("a")] });
  });
  expect(await g.run()).toEqual({ kind: "failure" });
  expect(g.logs).toEqual([]);
});
