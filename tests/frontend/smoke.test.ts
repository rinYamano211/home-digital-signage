import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/frontend/App";

describe("frontend tooling", () => {
  it("loads a React component from src/frontend", () => {
    expect(isValidElement(App())).toBe(true);
  });
});
