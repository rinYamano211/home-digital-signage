import { createElement, isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/frontend/App";

describe("frontend tooling", () => {
  // `App`はHook（Polling・時刻）を使うため、関数として直接は呼ばずに要素を作る（Issue #10）。
  it("loads a React component from src/frontend", () => {
    expect(typeof App).toBe("function");
    expect(isValidElement(createElement(App))).toBe(true);
  });
});
