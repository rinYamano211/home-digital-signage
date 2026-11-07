import { describe, expect, it } from "vitest";
import { fitScreen } from "../../src/frontend/layout/scale";

describe("fitScreen", () => {
  it("is 1:1 with no offset on the 1280x800 display", () => {
    expect(fitScreen(1280, 800)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it("does not enlarge on a larger viewport and centers the screen", () => {
    expect(fitScreen(1920, 1080)).toEqual({
      scale: 1,
      offsetX: 320,
      offsetY: 140,
    });
  });

  it("shrinks proportionally when the viewport is narrower", () => {
    expect(fitScreen(640, 800)).toEqual({
      scale: 0.5,
      offsetX: 0,
      offsetY: 200,
    });
  });

  it("shrinks proportionally when the viewport is shorter", () => {
    expect(fitScreen(1280, 400)).toEqual({
      scale: 0.5,
      offsetX: 320,
      offsetY: 0,
    });
  });

  it("never returns a negative scale", () => {
    expect(fitScreen(0, 0).scale).toBe(0);
  });
});
