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

/** 降雨帯。#93が終わるまで、本番では`rainForecast`が省略されるため固定の表示（UI設計 6.5）。 */
function Rain() {
  return (
    <div className="weather-rain is-muted">
      <CloudOffIcon className="weather-rain-icon" />
      <span>雨の予報を取得できません</span>
    </div>
  );
}

function Slot({ slot }: { slot: HourlySlot }) {
  return (
    <div className={`weather-slot ${slot.dayStart ? "is-day-start" : ""}`}>
      <span className="weather-slot-hour">{slot.label}</span>
      <WeatherIcon
        category={slot.category}
        night={slot.night}
        className="weather-slot-icon"
      />
      <span className="weather-slot-temp">{slot.temperature}°</span>
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
            <Slot key={slot.validAt} slot={slot} />
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
      <Rain />
      <Hourly view={view} />
      <WeatherAttribution />
    </div>
  );
}
