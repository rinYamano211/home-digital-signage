import { HourglassIcon } from "../icons/HourglassIcon";
import { CloudOffIcon } from "../icons/WeatherIcons";

/** 取得中・取得できない部分の表示（UI設計 6.1・6.5）。タイルの領域は空けたまま残す。 */
export function WeatherMessage({
  loading,
  subject,
}: {
  readonly loading: boolean;
  /** `現在の天気`・`時間ごとの天気`等。 */
  readonly subject: string;
}) {
  return (
    <div className="weather-message">
      {loading ? (
        <HourglassIcon className="weather-message-icon" />
      ) : (
        <CloudOffIcon className="weather-message-icon" />
      )}
      {loading ? `${subject}を取得しています` : `${subject}を取得できません`}
    </div>
  );
}

/** 出典表示（UI設計 5.2・5.3、technology-stack 16.6）。Open-MeteoのCC BY 4.0に従う。 */
export function WeatherAttribution() {
  return (
    <div className="weather-attribution">Weather data by Open-Meteo.com</div>
  );
}
