import pino, { type DestinationStream } from "pino";
import type { BackendConfig } from "../config/schema.js";

const sensitiveKeys = [
  "secret",
  "secrets",
  "credential",
  "credentials",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "password",
  "privateKey",
  "private_key",
  "clientSecret",
  "client_secret",
  "authorization",
  "cookie",
];

export function createLogger(
  level: BackendConfig["logLevel"] = "info",
  destination?: DestinationStream,
) {
  return pino(
    {
      level,
      base: { service: "backend" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: sensitiveKeys
          .flatMap((key) => [key, `*.${key}`])
          .concat(["req.headers", "req.body", "res.headers"]),
        censor: "[REDACTED]",
      },
      // Do not serialize arbitrary exception messages, request URLs or headers.
      serializers: {
        err: () => ({ type: "Error", message: "Details omitted" }),
        req: (request: { method?: string }) => ({ method: request.method }),
        res: (response: { statusCode?: number }) => ({
          statusCode: response.statusCode,
        }),
      },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
