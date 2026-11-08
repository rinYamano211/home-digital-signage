// 表示用API（GET /api/published-states）のResponseの型とRuntime Validation
// （docs/technology-stack.md 10.2・10.4・10.7、docs/frontend-development.md 11.2・11.3）。
// Backendのコードはimportしない（実行環境が異なるため。frontend-development 第2章）。
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { validScheduleShape } from "../schedule/schedule-data";
import { utcInstant } from "./utc-instant";

export const STATE_KEYS = [
  "currentWeather",
  "hourlyWeather",
  "rainForecast",
  "weeklyWeather",
  "schedule",
] as const;
export type StateKey = (typeof STATE_KEYS)[number];

const Instant = Type.Union([Type.String(), Type.Null()]);
const MetaSchema = Type.Object(
  {
    dataUpdatedAt: Instant,
    expiresAt: Instant,
    lastAttemptAt: Instant,
    lastAttemptResult: Type.Union([
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Null(),
    ]),
    publishedAt: Type.String(),
    dataSource: Type.Union([
      Type.Literal("externalApi"),
      Type.Literal("cache"),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
/** State共通部分：各Stateの`data`（ObjectまたはNull）と`meta`。 */
const StateSchema = Type.Object(
  {
    data: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    meta: MetaSchema,
  },
  { additionalProperties: false },
);
/** 外枠：トップレベルの`schemaVersion`と`states`。 */
const EnvelopeSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  states: Type.Record(Type.String(), Type.Unknown()),
});

export type PublishedStateMeta = Static<typeof MetaSchema>;
export type PublishedState = Static<typeof StateSchema>;
export type PublishedStates = Partial<Record<StateKey, PublishedState>>;

const instantOk = (value: string | null) =>
  value === null || utcInstant(value) !== null;

/** State共通部分のSchemaと、Metadataの整合（10.6）。 */
function validState(value: unknown): value is PublishedState {
  if (!Value.Check(StateSchema, value)) return false;
  const m = value.meta;
  if (
    !instantOk(m.dataUpdatedAt) ||
    !instantOk(m.expiresAt) ||
    !instantOk(m.lastAttemptAt) ||
    !instantOk(m.publishedAt)
  )
    return false;
  if ((m.dataUpdatedAt === null) !== (m.expiresAt === null)) return false;
  if ((m.lastAttemptAt === null) !== (m.lastAttemptResult === null))
    return false;
  if (value.data === null) return m.dataSource === null;
  return m.dataSource !== null && m.expiresAt !== null;
}

/** Domain部分の検証。天気（#9）はまだ持たない。 */
const DOMAIN: Partial<Record<StateKey, (data: unknown) => boolean>> = {
  schedule: validScheduleShape,
};

/**
 * Responseの検証。外枠が不正ならnull（Polling失敗）。
 * 外枠が正しい場合、State共通部分・Domain部分の検証に通らないStateだけを除外する
 * （省略されたものとして扱う。frontend-development 11.3）。未知のKeyは無視する。
 */
export function parsePublishedStates(value: unknown): PublishedStates | null {
  if (!Value.Check(EnvelopeSchema, value)) return null;
  const states: PublishedStates = {};
  for (const key of STATE_KEYS) {
    const state = value.states[key];
    if (state === undefined || !validState(state)) continue;
    const domain = DOMAIN[key];
    if (state.data !== null && domain !== undefined && !domain(state.data))
      continue;
    states[key] = state;
  }
  return states;
}
