import { describe, it, expect } from "vitest";
import { jsonLiteral } from "./apple-script.js";

describe("jsonLiteral", () => {
  it("escapes double quotes safely", () => {
    expect(jsonLiteral(`hello "world"`)).toBe(`"hello \\"world\\""`);
  });

  it("escapes backslashes", () => {
    expect(jsonLiteral(`a\\b`)).toBe(`"a\\\\b"`);
  });

  it("handles newlines", () => {
    expect(jsonLiteral("line1\nline2")).toBe(`"line1\\nline2"`);
  });

  it("handles unicode", () => {
    expect(jsonLiteral("café")).toBe(`"café"`);
  });

  it("encodes objects", () => {
    expect(jsonLiteral({ a: 1, b: "x" })).toBe(`{"a":1,"b":"x"}`);
  });

  it("escapes U+2028 / U+2029 line terminators (JS source-level hazard)", () => {
    expect(jsonLiteral("a b")).toBe(`"a\\u2028b"`);
    expect(jsonLiteral("x y")).toBe(`"x\\u2029y"`);
  });
});
