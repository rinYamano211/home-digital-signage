import { WeatherIcon } from "../icons/WeatherIcons";
import { StaleBadge } from "../schedule/SchedulePanel";
import { WeatherAttribution, WeatherMessage } from "./WeatherParts";
import type { PartView, WeeklyDay } from "./weather-state";

function Day({ day }: { day: WeeklyDay }) {
  return (
    <div className={`weather-day ${day.today ? "is-today" : ""}`}>
      <div className="weather-day-label">
        <span className={day.weekend ? `is-${day.weekend}` : ""}>
          {day.label}
        </span>
        <small>{day.monthDay}</small>
      </div>
      {/* 週間天気は昼のアイコンを使う（UI設計 5.4）。 */}
      <WeatherIcon
        category={day.category}
        night={false}
        className="weather-day-icon"
      />
      <div className={`weather-day-pop ${day.wet ? "is-wet" : ""}`}>
        {day.precipitation}%
      </div>
      <div className="weather-day-min">{day.min}°</div>
      <div className="weather-day-bar">
        <div
          className="weather-day-bar-fill"
          style={{ left: `${day.barLeft}%`, right: `${day.barRight}%` }}
        />
      </div>
      <div className="weather-day-max">{day.max}°</div>
    </div>
  );
}

type Props = { readonly view: PartView<readonly WeeklyDay[]> };

/** 週間天気（UI設計 5.3）。巡回に残るのは`shown`だけ（6.2）。 */
export function WeeklyWeatherPanel({ view }: Props) {
  if (view.kind !== "shown")
    // 巡回からは外れる。切替の途中で状態が変わったときだけ描画される。
    return (
      <div className="weather-panel weather-weekly">
        <div className="tile weather-days">
          <WeatherMessage
            loading={view.kind === "loading"}
            subject="週間天気"
          />
        </div>
        <WeatherAttribution />
      </div>
    );
  const { value, stale } = view;
  return (
    <div className="weather-panel weather-weekly">
      <div className={`tile weather-days ${stale ? "has-badge" : ""}`}>
        {stale && <StaleBadge since={stale.since} />}
        {value.map((day) => (
          <Day key={day.date} day={day} />
        ))}
      </div>
      <WeatherAttribution />
    </div>
  );
}
