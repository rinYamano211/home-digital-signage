import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { createHttpAdapter } from "../../src/backend/http/native-http-adapter.js";
import { NativeHttpAdapter } from "../../src/backend/http/internal/native-http-adapter.js";
import { deferred, checkpoint } from "../support/http-adapter-fixture.js";
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
function observedAdapter(
  url: string,
  headersReady: () => void,
  limit = 262144,
) {
  return new NativeHttpAdapter(
    { url, maxBodyBytes: limit },
    {
      fetch: (i, init) =>
        fetch(i, init).then((r) => {
          headersReady();
          return r;
        }),
      timeout: (ms) => AbortSignal.timeout(ms),
      combine: (s) => AbortSignal.any(s),
    },
  );
}
test.each([200, 429, 500])(
  "native loopback I09 %s metadata and bytes",
  async (status) => {
    await server(
      (_req, res) => {
        res.writeHead(status, { "retry-after": "12" });
        res.end("hello");
      },
      async (url) => {
        let ends = 0;
        const outcome = await createHttpAdapter({
          url,
          maxBodyBytes: 262144,
        }).start(new AbortController().signal, () => {
          ends++;
        });
        expect(outcome).toEqual({
          kind: "response",
          http: { status, retryAfter: "12" },
          body: new TextEncoder().encode("hello"),
        });
        expect(ends).toBe(1);
      },
    );
  },
);
test("native loopback I05 headers do not complete Body or release lifecycle", async () => {
  const headers = deferred<void>();
  let response!: ServerResponse;
  await server(
    (_req, res) => {
      response = res;
      res.writeHead(200);
      res.flushHeaders();
      res.write("first");
    },
    async (url) => {
      let ends = 0,
        delivered = false;
      const p = observedAdapter(url, () => headers.resolve()).start(
        new AbortController().signal,
        () => {
          ends++;
        },
      );
      void p.then(() => {
        delivered = true;
      });
      await headers.promise;
      await checkpoint();
      expect(ends).toBe(0);
      expect(delivered).toBe(false);
      response.end("last");
      expect((await p).kind).toBe("response");
      expect(ends).toBe(1);
    },
  );
});
test("native loopback I08/I09 controlled Abort after headers preserves metadata", async () => {
  const headers = deferred<void>();
  const abort = new AbortController();
  await server(
    (_req, res) => {
      res.writeHead(429, { "retry-after": "12" });
      res.flushHeaders();
      res.write("first");
    },
    async (url) => {
      let ends = 0;
      const p = observedAdapter(url, () => headers.resolve()).start(
        abort.signal,
        () => {
          ends++;
        },
      );
      await headers.promise;
      abort.abort();
      expect(await p).toEqual({
        kind: "aborted",
        http: { status: 429, retryAfter: "12" },
      });
      expect(ends).toBe(1);
    },
  );
});
test("native loopback I09 truncated 500 Body is body_error, metadata retained", async () => {
  const headers = deferred<void>();
  let response!: ServerResponse;
  await server(
    (_req, res) => {
      response = res;
      res.writeHead(500, { "content-length": "100", "retry-after": "12" });
      res.flushHeaders();
      res.write("short");
    },
    async (url) => {
      const p = observedAdapter(url, () => headers.resolve()).start(
        new AbortController().signal,
        () => {},
      );
      await headers.promise;
      response.destroy();
      expect(await p).toEqual({
        kind: "body_error",
        http: { status: 500, retryAfter: "12" },
      });
    },
  );
});
test("native loopback I10 gzip cap measures expanded application bytes", async () => {
  const compressed = gzipSync(new Uint8Array(262145));
  await server(
    (_req, res) => {
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      res.end(compressed);
    },
    async (url) => {
      expect(
        (
          await createHttpAdapter({ url, maxBodyBytes: 262144 }).start(
            new AbortController().signal,
            () => {},
          )
        ).kind,
      ).toBe("body_too_large");
    },
  );
});
test("native loopback I10 compressed body exactly at cap accepted", async () => {
  const compressed = gzipSync(new Uint8Array(262144));
  await server(
    (_req, res) => {
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      res.end(compressed);
    },
    async (url) => {
      const result = await createHttpAdapter({
        url,
        maxBodyBytes: 262144,
      }).start(new AbortController().signal, () => {});
      expect(result.kind).toBe("response");
      if (result.kind === "response")
        expect(result.body.byteLength).toBe(262144);
    },
  );
});
test("native loopback I08 same 10 second Timeout persists after headers", async () => {
  await server(
    (_req, res) => {
      res.writeHead(429, { "retry-after": "12" });
      res.flushHeaders();
      res.write("first");
    },
    async (url) => {
      let ends = 0;
      const result = await createHttpAdapter({
        url,
        maxBodyBytes: 262144,
      }).start(new AbortController().signal, () => {
        ends++;
      });
      expect(result).toEqual({
        kind: "timeout",
        http: { status: 429, retryAfter: "12" },
      });
      expect(ends).toBe(1);
    },
  );
}, 20000);
