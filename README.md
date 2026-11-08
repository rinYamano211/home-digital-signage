# Home Digital Signage

Raspberry Piを利用した家庭用デジタルサイネージ。

## Overview

自宅のディスプレイに時計・予定・気温・天気予報・写真などを表示する。

## Documentation

- [企画書](docs/home-digital-signage-project-plan.md)

- [ハードウェア検討・選定結果](docs/hardware.md)
- [MVP要件・検討経過](docs/requirements.md)
- [UI設計](docs/ui-design.md)
- [学習記録](docs/learning-log.md)
- [Home Digital Signage - Development Roadmap](https://github.com/users/rinYamano211/projects/1)

## Weather data

天気の情報は[Open-Meteo](https://open-meteo.com/)のForecast APIから取得する（Issue #9）。

- データは[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)で提供される（[Open-Meteoのライセンス](https://open-meteo.com/en/licence)）。サイネージの天気の画面には`Weather data by Open-Meteo.com`と表示する。
- 無料APIは非商用の利用に限られる（[利用規約](https://open-meteo.com/en/terms)）。
- Open-Meteoが利用する元データ提供者（気象庁等）について、追加の表示が必要かどうかは未確認である（[技術スタック選定 16.6](docs/technology-stack.md#weather-issue-9-design)）。
