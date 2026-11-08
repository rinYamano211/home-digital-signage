// 天気のDomain Data（docs/technology-stack.md 19.2・20.1・22.2）の型とRuntime Validation
// （docs/frontend-development.md 12.1）。件数（24枠・7日）はBackendの採用条件なので見ない。
// 現在時刻から選べる枠・日が足りないときの扱いは、表示時に決める（weather-state.ts）。
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  scheduleInstant,
  validDateString,
} from "../published-state/utc-instant";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const Finite = Type.Number();
const Code = Type.Integer();
const Probability = Type.Number({ minimum: 0, maximum: 100 });
const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

const CurrentWeatherDataSchema = Type.Object(
  {
    temperatureC: Finite,
    weatherCode: Code,
    isDay: Type.Boolean(),
    validAt: Type.String(),
  },
  { additionalProperties: false },
);
const HourlyWeatherDataSchema = Type.Object(
  {
    hours: Type.Array(
      Type.Object(
        {
          validAt: Type.String(),
          temperatureC: Finite,
          weatherCode: Code,
          precipitationProbability: Probability,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const WeeklyWeatherDataSchema = Type.Object(
  {
    days: Type.Array(
      Type.Object(
        {
          date: DateString,
          weatherCode: Code,
          temperatureMaxC: Finite,
          temperatureMinC: Finite,
          precipitationProbability: Probability,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type CurrentWeatherData = Static<typeof CurrentWeatherDataSchema>;
export type HourlyWeatherData = Static<typeof HourlyWeatherDataSchema>;
export type HourlyWeatherItem = HourlyWeatherData["hours"][number];
export type WeeklyWeatherData = Static<typeof WeeklyWeatherDataSchema>;
export type WeeklyWeatherItem = WeeklyWeatherData["days"][number];

const finite = (value: number) => Number.isFinite(value);
const code = (value: number) => Number.isSafeInteger(value);
/** JSTの`date`の0時（ms）。Asia/Tokyoは夏時間がないためUTC+9で求める。 */
const dayStart = (date: string) => Date.parse(`${date}T00:00:00+09:00`);

/** 気温・天気コード・`validAt`（`toISOString()`の形だけ。technology-stack 16.6）。 */
export function validCurrentWeatherShape(
  value: unknown,
): value is CurrentWeatherData {
  return (
    Value.Check(CurrentWeatherDataSchema, value) &&
    finite(value.temperatureC) &&
    code(value.weatherCode) &&
    scheduleInstant(value.validAt) !== null
  );
}

/** 正時の`validAt`が1時間間隔で連続していること（20.3）。 */
export function validHourlyWeatherShape(
  value: unknown,
): value is HourlyWeatherData {
  if (!Value.Check(HourlyWeatherDataSchema, value)) return false;
  let previous: number | null = null;
  for (const hour of value.hours) {
    const at = scheduleInstant(hour.validAt);
    if (at === null || at % HOUR_MS !== 0) return false;
    if (previous !== null && at !== previous + HOUR_MS) return false;
    if (!finite(hour.temperatureC) || !code(hour.weatherCode)) return false;
    previous = at;
  }
  return true;
}

/** 実在するJST暦日が1日間隔で連続し、最低 <= 最高であること（22.2・22.3）。 */
export function validWeeklyWeatherShape(
  value: unknown,
): value is WeeklyWeatherData {
  if (!Value.Check(WeeklyWeatherDataSchema, value)) return false;
  let previous: number | null = null;
  for (const day of value.days) {
    if (!validDateString(day.date)) return false;
    const at = dayStart(day.date);
    if (previous !== null && at !== previous + DAY_MS) return false;
    if (
      !code(day.weatherCode) ||
      !finite(day.temperatureMaxC) ||
      !finite(day.temperatureMinC) ||
      !(day.temperatureMinC <= day.temperatureMaxC)
    )
      return false;
    previous = at;
  }
  return true;
}
