import { describe, expect, it } from "vitest";
import { isNearBottom } from "./ChatView";

describe("isNearBottom", () => {
  it("counts the last 80px as the end", () => {
    expect(isNearBottom(921, 1500, 500)).toBe(true); // 79px left
    expect(isNearBottom(920, 1500, 500)).toBe(false); // exactly 80px left
    expect(isNearBottom(1000, 1500, 500)).toBe(true);
    expect(isNearBottom(900, 1500, 500)).toBe(false);
    expect(isNearBottom(0, 400, 500)).toBe(true); // shorter than the view
  });
});
