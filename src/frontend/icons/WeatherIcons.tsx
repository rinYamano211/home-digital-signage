// Tabler Icons（outline、@tabler/icons 3.19.0）の「sun」「moon」「cloud」「mist」「cloud-rain」
// 「snowflake」「cloud-storm」「question-mark」「cloud-off」のSVGを同梱したもの。
// UIモック（docs/ui-mock/signage-mock.html）の天気アイコンと同じ（UI設計 5.4、
// docs/frontend-development.md 12.4）。依存パッケージは追加しない。
//
// MIT License
//
// Copyright (c) 2020-2024 Paweł Kuna
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import type { WeatherCategory } from "../weather/weather-state";

const PATHS = {
  sun: [
    "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
    "M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7",
  ],
  moon: [
    "M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z",
  ],
  cloud: [
    "M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878",
  ],
  mist: ["M5 5h3m4 0h9", "M3 10h11m4 0h1", "M5 15h5m4 0h7", "M3 20h9m4 0h3"],
  cloudRain: [
    "M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7",
    "M11 13v2m0 3v2m4 -5v2m0 3v2",
  ],
  snowflake: [
    "M10 4l2 1l2 -1",
    "M12 2v6.5l3 1.72",
    "M17.928 6.268l.134 2.232l1.866 1.232",
    "M20.66 7l-5.629 3.25l.01 3.458",
    "M19.928 14.268l-1.866 1.232l-.134 2.232",
    "M20.66 17l-5.629 -3.25l-2.99 1.738",
    "M14 20l-2 -1l-2 1",
    "M12 22v-6.5l-3 -1.72",
    "M6.072 17.732l-.134 -2.232l-1.866 -1.232",
    "M3.34 17l5.629 -3.25l-.01 -3.458",
    "M4.072 9.732l1.866 -1.232l.134 -2.232",
    "M3.34 7l5.629 3.25l2.99 -1.738",
  ],
  cloudStorm: [
    "M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1",
    "M13 14l-2 4l3 0l-2 4",
  ],
  questionMark: [
    "M8 8a3.5 3 0 0 1 3.5 -3h1a3.5 3 0 0 1 3.5 3a3 3 0 0 1 -2 3a3 4 0 0 0 -2 4",
    "M12 19l0 .01",
  ],
  cloudOff: [
    "M9.58 5.548c.24 -.11 .492 -.207 .752 -.286c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 .957 -.383 1.824 -1.003 2.454m-2.997 1.033h-11.343c-2.572 -.004 -4.657 -2.011 -4.657 -4.487c0 -2.475 2.085 -4.482 4.657 -4.482c.13 -.582 .37 -1.128 .7 -1.62",
    "M3 3l18 18",
  ],
} as const;
type IconName = keyof typeof PATHS;

function TablerIcon({
  name,
  className,
}: {
  readonly name: IconName;
  readonly className?: string;
}) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** 天気コードの区分ごとのアイコン（UI設計 5.4）。晴れの夜は月。 */
export function weatherIconName(
  category: WeatherCategory,
  night: boolean,
): IconName {
  switch (category) {
    case "clear":
      return night ? "moon" : "sun";
    case "cloudy":
      return "cloud";
    case "fog":
      return "mist";
    case "rain":
      return "cloudRain";
    case "snow":
      return "snowflake";
    case "storm":
      return "cloudStorm";
    case "unknown":
      return "questionMark";
  }
}

type WeatherIconProps = {
  readonly category: WeatherCategory;
  readonly night: boolean;
  readonly className?: string;
};

export function WeatherIcon({ category, night, className }: WeatherIconProps) {
  return (
    <TablerIcon name={weatherIconName(category, night)} className={className} />
  );
}

/** 天気を取得できないときのアイコン（UIモックと同じ）。 */
export function CloudOffIcon({ className }: { readonly className?: string }) {
  return <TablerIcon name="cloudOff" className={className} />;
}
