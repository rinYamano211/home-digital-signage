import { Type, type Static } from "@sinclair/typebox";

export const LogLevelSchema = Type.Union([
  Type.Literal("fatal"),
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
  Type.Literal("debug"),
  Type.Literal("trace"),
  Type.Literal("silent"),
]);

export const BackendConfigSchema = Type.Object(
  {
    dataDirectory: Type.String({ minLength: 1 }),
    host: Type.Literal("127.0.0.1"),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    logLevel: LogLevelSchema,
    shutdownTimeoutMs: Type.Literal(10000),
  },
  { additionalProperties: false },
);

export type BackendConfig = Readonly<Static<typeof BackendConfigSchema>>;
