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
    /** Google Calendar ID (Issue #10). Unset: no Schedule Provider. Printable
     * ASCII without spaces; an empty or other value is an invalid Config.
     */
    scheduleCalendarId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 1024, pattern: "^[!-~]+$" }),
    ),
    /** Open-Meteo target location (Issue #9, technology-stack 16.6). Unset: no
     * Weather Provider. Never logged or published (it is the home location).
     */
    weatherLocation: Type.Optional(
      Type.Object(
        {
          latitude: Type.Number({ minimum: -90, maximum: 90 }),
          longitude: Type.Number({ minimum: -180, maximum: 180 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type BackendConfig = Readonly<Static<typeof BackendConfigSchema>>;
