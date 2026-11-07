import { describe, expect, it } from "vitest";
import {
  clockFaceKind,
  shouldFadeInClock,
} from "../../src/frontend/clock/availability";

describe("clockFaceKind", () => {
  it("shows the clock only when time is available", () => {
    expect(clockFaceKind("available")).toBe("clock");
    expect(clockFaceKind("unavailable")).toBe("unavailable");
  });
});

describe("shouldFadeInClock", () => {
  it("fades in only when recovering from unavailable to available", () => {
    expect(shouldFadeInClock("unavailable", "available")).toBe(true);
  });

  it("does not fade otherwise", () => {
    expect(shouldFadeInClock("available", "available")).toBe(false);
    expect(shouldFadeInClock("available", "unavailable")).toBe(false);
    expect(shouldFadeInClock("unavailable", "unavailable")).toBe(false);
  });
});
