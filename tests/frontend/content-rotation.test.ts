import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeAvailability } from "../../src/frontend/clock/availability";
import {
  advanceView,
  ContentRotation,
  dwellMs,
  initialView,
  reconcileView,
  type RotationEntry,
  type RotationInput,
  type RotationView,
} from "../../src/frontend/content/rotation";

// ダミーのコンテンツ定義で、切替のロジックを確かめる（docs/frontend-development.md 10.8 S8）。
// 表示時間はテスト用にコンテンツごとに変えて、設定値どおりに切り替わることを確かめる。
const A: RotationEntry = { id: "schedule", durationMs: 10_000 };
const B: RotationEntry = { id: "todayWeather", durationMs: 8_000 };
const C: RotationEntry = { id: "weeklyWeather", durationMs: 12_000 };
const ENTRIES = [A, B, C] as const;

function input(
  displayable: readonly string[],
  time: TimeAvailability = "available",
): RotationInput {
  return { displayable: new Set(displayable), time };
}

const ALL = input(["schedule", "todayWeather", "weeklyWeather"]);

function content(id: string): RotationView {
  return { kind: "content", id };
}

describe("rotation decisions", () => {
  it("starts from the first content (today's schedule)", () => {
    expect(initialView(ENTRIES, ALL)).toEqual(content("schedule"));
  });

  it("starts from the first displayable content when earlier ones are skipped", () => {
    expect(initialView(ENTRIES, input(["weeklyWeather"]))).toEqual(
      content("weeklyWeather"),
    );
  });

  it("advances in the fixed order and wraps back to the first", () => {
    const order: string[] = [];
    let view = initialView(ENTRIES, ALL);
    for (let i = 0; i < 6; i++) {
      if (view.kind === "content") order.push(view.id);
      view = advanceView(ENTRIES, view, ALL);
    }
    expect(order).toEqual([
      "schedule",
      "todayWeather",
      "weeklyWeather",
      "schedule",
      "todayWeather",
      "weeklyWeather",
    ]);
  });

  it("skips content that cannot be displayed and keeps rotating the rest", () => {
    const partial = input(["schedule", "weeklyWeather"]);
    const first = advanceView(ENTRIES, content("schedule"), partial);
    expect(first).toEqual(content("weeklyWeather"));
    expect(advanceView(ENTRIES, first, partial)).toEqual(content("schedule"));
  });

  it("keeps the same content when it is the only displayable one", () => {
    const only = input(["todayWeather"]);
    expect(advanceView(ENTRIES, content("todayWeather"), only)).toEqual(
      content("todayWeather"),
    );
  });

  it("shows the no-content card when nothing can be displayed", () => {
    expect(initialView(ENTRIES, input([]))).toEqual({ kind: "noContent" });
    expect(advanceView(ENTRIES, content("schedule"), input([]))).toEqual({
      kind: "noContent",
    });
  });

  it("shows the time card while time is unavailable, even if content is displayable", () => {
    const unsynced = input(
      ["schedule", "todayWeather", "weeklyWeather"],
      "unavailable",
    );
    expect(initialView(ENTRIES, unsynced)).toEqual({ kind: "timeUnavailable" });
    expect(reconcileView(ENTRIES, content("todayWeather"), unsynced)).toEqual({
      kind: "timeUnavailable",
    });
  });

  it("keeps the current content when it stays displayable", () => {
    const current = content("todayWeather");
    expect(reconcileView(ENTRIES, current, ALL)).toBe(current);
  });

  it("moves on immediately when the current content becomes undisplayable", () => {
    expect(
      reconcileView(
        ENTRIES,
        content("todayWeather"),
        input(["schedule", "weeklyWeather"]),
      ),
    ).toEqual(content("weeklyWeather"));
  });

  it("restarts from today's schedule after a card", () => {
    expect(reconcileView(ENTRIES, { kind: "timeUnavailable" }, ALL)).toEqual(
      content("schedule"),
    );
    expect(reconcileView(ENTRIES, { kind: "noContent" }, ALL)).toEqual(
      content("schedule"),
    );
  });

  it("uses each content's configured duration and no timer for cards", () => {
    expect(dwellMs(ENTRIES, content("schedule"))).toBe(10_000);
    expect(dwellMs(ENTRIES, content("todayWeather"))).toBe(8_000);
    expect(dwellMs(ENTRIES, { kind: "timeUnavailable" })).toBeNull();
    expect(dwellMs(ENTRIES, { kind: "noContent" })).toBeNull();
  });

  it("rotates added content without changing the logic", () => {
    const extra: RotationEntry = { id: "photos", durationMs: 5_000 };
    const entries = [...ENTRIES, extra];
    const withExtra = input([...ALL.displayable, "photos"]);
    expect(advanceView(entries, content("weeklyWeather"), withExtra)).toEqual(
      content("photos"),
    );
    expect(advanceView(entries, content("photos"), withExtra)).toEqual(
      content("schedule"),
    );
  });
});

describe("ContentRotation timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(initial: RotationInput) {
    const changes: RotationView[] = [];
    const rotation = new ContentRotation(ENTRIES, initial, (view) =>
      changes.push(view),
    );
    return { rotation, changes };
  }

  it("switches at each content's configured interval, counted from each switch", () => {
    const { rotation, changes } = start(ALL);
    expect(rotation.view).toEqual(content("schedule"));

    vi.advanceTimersByTime(9_999);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([content("todayWeather")]);

    vi.advanceTimersByTime(8_000);
    expect(rotation.view).toEqual(content("weeklyWeather"));
    vi.advanceTimersByTime(12_000);
    expect(rotation.view).toEqual(content("schedule"));
    expect(changes).toHaveLength(3);
    rotation.dispose();
  });

  it("keeps rotating the displayable content while one content fails", () => {
    const { rotation, changes } = start(ALL);
    rotation.update(input(["schedule", "weeklyWeather"]));

    vi.advanceTimersByTime(10_000 + 12_000 + 10_000 + 12_000);
    expect(changes).toEqual([
      content("weeklyWeather"),
      content("schedule"),
      content("weeklyWeather"),
      content("schedule"),
    ]);
    rotation.dispose();
  });

  it("does not interrupt the current content when another one recovers", () => {
    const { rotation, changes } = start(input(["schedule", "weeklyWeather"]));
    vi.advanceTimersByTime(4_000);
    rotation.update(ALL);
    expect(changes).toEqual([]);

    // 表示時間は切り替わった時点からのまま。次は復帰した今日の天気。
    vi.advanceTimersByTime(6_000);
    expect(changes).toEqual([content("todayWeather")]);
    rotation.dispose();
  });

  it("switches immediately when the current content becomes undisplayable, and restarts the timer", () => {
    const { rotation, changes } = start(ALL);
    vi.advanceTimersByTime(4_000);
    rotation.update(input(["todayWeather", "weeklyWeather"]));
    expect(changes).toEqual([content("todayWeather")]);

    vi.advanceTimersByTime(7_999);
    expect(changes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([
      content("todayWeather"),
      content("weeklyWeather"),
    ]);
    rotation.dispose();
  });

  it("does not re-announce the same content when it is the only one", () => {
    const { rotation, changes } = start(input(["todayWeather"]));
    vi.advanceTimersByTime(8_000 * 5);
    expect(changes).toEqual([]);
    expect(rotation.view).toEqual(content("todayWeather"));
    rotation.dispose();
  });

  it("stops on the no-content card and resumes from today's schedule", () => {
    const { rotation, changes } = start(ALL);
    vi.advanceTimersByTime(10_000);
    rotation.update(input([]));
    expect(rotation.view).toEqual({ kind: "noContent" });

    vi.advanceTimersByTime(60_000);
    expect(changes).toEqual([content("todayWeather"), { kind: "noContent" }]);

    rotation.update(ALL);
    expect(rotation.view).toEqual(content("schedule"));
    vi.advanceTimersByTime(10_000);
    expect(rotation.view).toEqual(content("todayWeather"));
    rotation.dispose();
  });

  it("stops while time is unavailable and resumes from today's schedule", () => {
    const { rotation, changes } = start(
      input(["schedule", "todayWeather", "weeklyWeather"], "unavailable"),
    );
    expect(rotation.view).toEqual({ kind: "timeUnavailable" });
    vi.advanceTimersByTime(60_000);
    expect(changes).toEqual([]);

    rotation.update(ALL);
    expect(changes).toEqual([content("schedule")]);
    vi.advanceTimersByTime(10_000);
    expect(rotation.view).toEqual(content("todayWeather"));
    rotation.dispose();
  });

  it("stops the timer after dispose", () => {
    const { rotation, changes } = start(ALL);
    rotation.dispose();
    vi.advanceTimersByTime(60_000);
    rotation.update(input([]));
    expect(changes).toEqual([]);
  });
});

// Reactの再マウント（StrictModeのEffect再実行等）で作り直すときに、画面の表示と内部の表示を揃える。
describe("ContentRotation re-creation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues from the given current view without announcing it again", () => {
    const changes: RotationView[] = [];
    const rotation = new ContentRotation(
      ENTRIES,
      ALL,
      (view) => changes.push(view),
      { current: content("weeklyWeather") },
    );
    expect(rotation.view).toEqual(content("weeklyWeather"));
    expect(changes).toEqual([]);

    vi.advanceTimersByTime(12_000);
    expect(changes).toEqual([content("schedule")]);
    rotation.dispose();
  });

  it("announces a corrected view when the given current view is no longer displayable", () => {
    const changes: RotationView[] = [];
    const rotation = new ContentRotation(
      ENTRIES,
      input(["schedule", "weeklyWeather"]),
      (view) => changes.push(view),
      { current: content("todayWeather") },
    );
    expect(changes).toEqual([content("weeklyWeather")]);
    expect(rotation.view).toEqual(content("weeklyWeather"));
    rotation.dispose();
  });

  it("announces the time card when time became unavailable before re-creation", () => {
    const changes: RotationView[] = [];
    const rotation = new ContentRotation(
      ENTRIES,
      input(["schedule", "todayWeather", "weeklyWeather"], "unavailable"),
      (view) => changes.push(view),
      { current: content("schedule") },
    );
    expect(changes).toEqual([{ kind: "timeUnavailable" }]);
    vi.advanceTimersByTime(60_000);
    expect(changes).toHaveLength(1);
    rotation.dispose();
  });

  it("leaves only one running timer after dispose and re-creation (StrictMode)", () => {
    const changes: RotationView[] = [];
    const onChange = (view: RotationView) => changes.push(view);

    const first = new ContentRotation(ENTRIES, ALL, onChange);
    vi.advanceTimersByTime(3_000);
    first.dispose();
    const second = new ContentRotation(ENTRIES, ALL, onChange, {
      current: first.view,
    });

    // 表示時間は作り直した時点から数える。前のTimerは発火しない。
    vi.advanceTimersByTime(9_999);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([content("todayWeather")]);
    vi.advanceTimersByTime(8_000);
    expect(changes).toEqual([
      content("todayWeather"),
      content("weeklyWeather"),
    ]);
    second.dispose();
  });
});
