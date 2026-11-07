import { describe, expect, it } from "vitest";
import { indicatorDots } from "../../src/frontend/content/indicator-dots";
import { CONTENTS } from "../../src/frontend/content/registry";
import { CONTENT_DURATION_MS } from "../../src/frontend/content/rotation-config";
import {
  finishTransition,
  initialPanels,
  renderedPanels,
  startTransition,
  viewKey,
} from "../../src/frontend/content/transition";

// Registry・インジケーター・切替アニメーションの状態を確かめる（docs/frontend-development.md 10.8）。
// 実際の描画（点の形・動き）はBrowserとRaspberry Piで目視確認する。

describe("content registry", () => {
  it("rotates today's schedule, today's weather and weekly weather in this order", () => {
    expect(CONTENTS.map((content) => content.id)).toEqual([
      "schedule",
      "todayWeather",
      "weeklyWeather",
    ]);
    expect(CONTENTS.map((content) => content.label)).toEqual([
      "今日の予定",
      "今日の天気",
      "週間天気",
    ]);
  });

  it("takes each display duration from the config", () => {
    for (const content of CONTENTS) {
      expect(content.durationMs).toBe(CONTENT_DURATION_MS[content.id]);
    }
  });

  it("starts with the provisional 10 seconds for every content", () => {
    expect(Object.values(CONTENT_DURATION_MS)).toEqual([
      10_000, 10_000, 10_000,
    ]);
  });
});

describe("indicator dots", () => {
  const all = new Set(CONTENTS.map((content) => content.id));

  it("marks the shown content as current", () => {
    expect(
      indicatorDots(CONTENTS, all, { kind: "content", id: "todayWeather" }).map(
        (dot) => dot.state,
      ),
    ).toEqual(["waiting", "current", "waiting"]);
  });

  it("marks content out of the rotation as skipped", () => {
    const partial = new Set(["schedule", "weeklyWeather"]);
    expect(
      indicatorDots(CONTENTS, partial, { kind: "content", id: "schedule" }).map(
        (dot) => dot.state,
      ),
    ).toEqual(["current", "skipped", "waiting"]);
  });

  it("shows no current dot while a card is shown", () => {
    expect(
      indicatorDots(CONTENTS, all, { kind: "timeUnavailable" }).map(
        (dot) => dot.state,
      ),
    ).toEqual(["waiting", "waiting", "waiting"]);
    expect(
      indicatorDots(CONTENTS, new Set(), { kind: "noContent" }).map(
        (dot) => dot.state,
      ),
    ).toEqual(["skipped", "skipped", "skipped"]);
  });
});

describe("content transition", () => {
  it("does not animate the first view", () => {
    const panels = initialPanels({ kind: "content", id: "schedule" });
    expect(panels).toEqual({
      current: { kind: "content", id: "schedule" },
      leaving: null,
      animate: false,
    });
  });

  it("keeps the previous view leaving until the transition finishes", () => {
    const first = initialPanels({ kind: "content", id: "schedule" });
    const moving = startTransition(first, {
      kind: "content",
      id: "todayWeather",
    });
    expect(moving.leaving).toEqual({ kind: "content", id: "schedule" });
    expect(moving.animate).toBe(true);
    expect(finishTransition(moving).leaving).toBeNull();
  });

  it("does not restart the animation for the same view", () => {
    const first = initialPanels({ kind: "content", id: "schedule" });
    expect(startTransition(first, { kind: "content", id: "schedule" })).toBe(
      first,
    );
  });

  it("gives each view a distinct key", () => {
    expect(
      new Set([
        viewKey({ kind: "content", id: "schedule" }),
        viewKey({ kind: "content", id: "todayWeather" }),
        viewKey({ kind: "timeUnavailable" }),
        viewKey({ kind: "noContent" }),
      ]).size,
    ).toBe(4);
  });
});

// 切替アニメーション（約0.6秒）の途中で、さらに表示が変わった場合。
describe("content transition during an ongoing animation", () => {
  const schedule = { kind: "content", id: "schedule" } as const;
  const today = { kind: "content", id: "todayWeather" } as const;
  const weekly = { kind: "content", id: "weeklyWeather" } as const;

  function keys(state: Parameters<typeof renderedPanels>[0]): string[] {
    return renderedPanels(state).map((panel) => panel.key);
  }

  it("renders at most two panels and drops the older leaving view", () => {
    let state = initialPanels(schedule);
    state = startTransition(state, today);
    state = startTransition(state, weekly);
    expect(keys(state)).toEqual([
      "content:todayWeather",
      "content:weeklyWeather",
    ]);
    expect(state.leaving).toEqual(today);
  });

  it("switches back to the view that was leaving without duplicating it", () => {
    let state = initialPanels(schedule);
    state = startTransition(state, today);
    state = startTransition(state, schedule);
    const panels = renderedPanels(state);
    expect(panels.map((panel) => panel.key)).toEqual([
      "content:todayWeather",
      "content:schedule",
    ]);
    expect(panels.map((panel) => panel.className)).toEqual([
      "content-panel content-exit",
      "content-panel content-enter",
    ]);
  });

  it("handles cards in quick succession and leaves one panel after finishing", () => {
    let state = initialPanels(schedule);
    state = startTransition(state, { kind: "noContent" });
    state = startTransition(state, { kind: "timeUnavailable" });
    state = startTransition(state, schedule);
    expect(keys(state)).toEqual(["timeUnavailable", "content:schedule"]);
    state = finishTransition(state);
    expect(keys(state)).toEqual(["content:schedule"]);
  });

  it("renders only the current panel when nothing is leaving", () => {
    expect(renderedPanels(initialPanels(schedule))).toEqual([
      { key: "content:schedule", view: schedule, className: "content-panel" },
    ]);
  });
});
