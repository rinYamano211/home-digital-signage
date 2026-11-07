// Issue #10 (technology-stack 18.7): POST support and Shutdown Abort on the
// common HTTP Adapter. Real Loopback only; no SQLite is needed.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { expect, test } from "vitest";
import { createHttpAdapter } from "../../src/backend/http/native-http-adapter.js";

async function server(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  work: (url: string) => Promise<void>,
) {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const address = http.address();
    if (!address || typeof address === "string") throw new Error();
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((e) => (e ? reject(e) : resolve())),
    );
  }
}

test("POST sends the method, headers and body; GET stays the default", async () => {
  const seen: { method?: string; type?: string; body: string }[] = [];
  await server(
    (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          type: req.headers["content-type"],
          body,
        });
        res.end("ok");
      });
    },
    async (url) => {
      const post = await createHttpAdapter({
        url,
        maxBodyBytes: 1024,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=test&assertion=synthetic",
      }).start(new AbortController().signal, () => {});
      expect(post).toMatchObject({ kind: "response", http: { status: 200 } });
      const get = await createHttpAdapter({ url, maxBodyBytes: 1024 }).start(
        new AbortController().signal,
        () => {},
      );
      expect(get).toMatchObject({ kind: "response", http: { status: 200 } });
    },
  );
  expect(seen).toEqual([
    {
      method: "POST",
      type: "application/x-www-form-urlencoded",
      body: "grant_type=test&assertion=synthetic",
    },
    { method: "GET", type: undefined, body: "" },
  ]);
});

test.each([
  { method: "GET" as const, body: "x" },
  { method: "POST" as const },
  { method: "PUT" as unknown as "GET" },
])("invalid method / body combination is rejected: %o", (extra) => {
  expect(() =>
    createHttpAdapter({
      url: "https://example.test/",
      maxBodyBytes: 1024,
      ...extra,
    }),
  ).toThrow(new TypeError("Invalid HTTP adapter configuration"));
});

test("Abort ends a request whose server never answers, well before the Timeout", async () => {
  await server(
    () => {
      /* accept and never respond */
    },
    async (url) => {
      const stop = new AbortController();
      let ended = 0;
      const started = performance.now();
      const pending = createHttpAdapter({ url, maxBodyBytes: 1024 }).start(
        stop.signal,
        () => {
          ended++;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      stop.abort();
      expect(await pending).toEqual({ kind: "aborted" });
      expect(ended).toBe(1);
      expect(performance.now() - started).toBeLessThan(3000);
    },
  );
});
