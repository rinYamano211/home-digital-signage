import { HourglassIcon } from "../icons/HourglassIcon";
import { CloudOffIcon, WeatherIcon } from "../icons/WeatherIcons";
import { StaleBadge } from "../schedule/SchedulePanel";
import { WeatherAttribution, WeatherMessage } from "./WeatherParts";
import {
  WEATHER_NAMES,
  type HourlySlot,
  type TodayWeatherView,
} from "./weather-state";

function Now({ view }: { view: TodayWeatherView }) {
  const { current, highLow } = view;
  if (current.kind !== "shown")
    return (
      <div className="tile weather-now">
        <WeatherMessage
          loading={current.kind === "loading"}
          subject="現在の天気"
        />
      </div>
    );
  const { value, stale } = current;
  return (
    <div className={`tile weather-now ${stale ? "has-badge" : ""}`}>
      {stale && <StaleBadge since={stale.since} />}
      <WeatherIcon
        category={value.category}
        night={value.night}
        className="weather-now-icon"
      />
      <span className="weather-now-temp">{value.temperature}°</span>
      <span className="weather-now-name">{WEATHER_NAMES[value.category]}</span>
      {highLow && (
        <div className="weather-now-highlow">
          <span className="weather-sub">最高</span> {highLow.max}°
          <br />
          <span className="weather-sub">最低</span> {highLow.min}°
        </div>
      )}
    </div>
  );
}

/** 帯の右端の更新待ち（UI設計 6.1）：`↻ 更新待ち`／`14:12時点`の2行。 */
function RainStale({ since }: { readonly since: string }) {
  return (
    <span className="weather-rain-stale">
      ↻ 更新待ち
      <br />
      {since}時点
    </span>
  );
}

/**
 * 降雨帯（UI設計 5.2・6.1、technology-stack 21.6）。取得中・更新待ち・取得できないを個別に表示し、
 * 他の部分や時計には影響しない。
 */
function Rain({ view }: { view: TodayWeatherView }) {
  const { rain } = view;
  if (rain.kind === "loading")
    return (
      <div className="weather-rain is-muted">
        <HourglassIcon className="weather-rain-icon" />
        <span>雨の予報を取得しています</span>
      </div>
    );
  if (rain.kind === "unavailable")
    return (
      <div className="weather-rain is-muted">
        <CloudOffIcon className="weather-rain-icon" />
        <span>雨の予報を取得できません</span>
      </div>
    );
  if (rain.kind === "waiting")
    return (
      <div className="weather-rain is-muted">
        <CloudOffIcon className="weather-rain-icon" />
        <span>雨の予報は更新待ち</span>
        <RainStale since={rain.since} />
      </div>
    );
  const { band, stale } = rain;
  if (band.kind === "rain")
    return (
      <div className="weather-rain is-rain">
        <WeatherIcon
          category="rain"
          night={false}
          className="weather-rain-icon"
        />
        <span className="weather-rain-text">{band.text}</span>
        {stale ? (
          <RainStale since={stale.since} />
        ) : (
          band.remaining && (
            <span className="weather-rain-remaining">{band.remaining}</span>
          )
        )}
      </div>
    );
  if (band.kind === "passed")
    return (
      <div className="weather-rain is-muted">
        <CloudOffIcon className="weather-rain-icon" />
        <span className="weather-rain-text">予報時刻を過ぎました</span>
        {stale && <RainStale since={stale.since} />}
      </div>
    );
  return (
    <div className="weather-rain is-muted">
      <WeatherIcon
        category="cloudy"
        night={false}
        className="weather-rain-icon"
      />
      <span className="weather-rain-text">1時間以内の雨の予報はありません</span>
      {stale && <RainStale since={stale.since} />}
    </div>
  );
}

/** 時間別の枠のclass。先頭の枠（次の正時）は`is-first`、日付の変わる枠は`is-day-start`（UI設計 5.2）。 */
function slotClassName(slot: HourlySlot, first: boolean): string {
  return ["weather-slot", first && "is-first", slot.dayStart && "is-day-start"]
    .filter(Boolean)
    .join(" ");
}

function Slot({ slot, first }: { slot: HourlySlot; first: boolean }) {
  return (
    <div className={slotClassName(slot, first)}>
      <span className="weather-slot-hour">{slot.label}</span>
      <WeatherIcon
        category={slot.category}
        night={slot.night}
        className="weather-slot-icon"
      />
      {/* `°`は数字の右肩に置き、中心合わせの幅に含めない（UI設計 5.2、Issue #98）。 */}
      <span className="weather-slot-temp">
        {slot.temperature}
        <span className="weather-slot-degree">°</span>
      </span>
      <span className={`weather-slot-pop ${slot.wet ? "is-wet" : ""}`}>
        {slot.precipitation}%
      </span>
    </div>
  );
}

function Hourly({ view }: { view: TodayWeatherView }) {
  const { hourly } = view;
  if (hourly.kind !== "shown")
    return (
      <div className="tile weather-hourly">
        <WeatherMessage
          loading={hourly.kind === "loading"}
          subject="時間ごとの天気"
        />
      </div>
    );
  const { value, stale } = hourly;
  // 6枠×2段（UI設計 5.2）。1〜11枠なら存在する枠だけを左から並べる（20.5）。
  const rows = [value.slice(0, 6), value.slice(6)].filter((r) => r.length > 0);
  return (
    <div className={`tile weather-hourly ${stale ? "has-badge" : ""}`}>
      {stale && <StaleBadge since={stale.since} />}
      {rows.map((row, index) => (
        <div key={index} className="weather-hourly-row">
          {row.map((slot) => (
            <Slot
              key={slot.validAt}
              slot={slot}
              first={slot.validAt === value[0]?.validAt}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

type Props = { readonly view: TodayWeatherView };

/** 今日の天気（UI設計 5.2）：現在の天気・降雨帯・時間別の3段と、出典表示。 */
export function TodayWeatherPanel({ view }: Props) {
  return (
    <div className="weather-panel weather-today">
      <Now view={view} />
      <Rain view={view} />
      <Hourly view={view} />
      <WeatherAttribution />
    </div>
  );
}
