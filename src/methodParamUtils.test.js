import { describe, expect, it, vi } from "vitest";

import {
  AUTO_TIMESTAMP_PARAM_KEYWORDS,
  getCurrentUnixTimestampSeconds,
  matchesAutoTimestampParamName,
} from "./methodParamUtils";

describe("AUTO_TIMESTAMP_PARAM_KEYWORDS", () => {
  it("keeps the default replay-protection keyword list in code", () => {
    expect(AUTO_TIMESTAMP_PARAM_KEYWORDS).toEqual(["nonce", "seq", "sequence"]);
  });
});

describe("matchesAutoTimestampParamName", () => {
  it("matches configured keywords case-insensitively by substring", () => {
    expect(matchesAutoTimestampParamName("nonce")).toBe(true);
    expect(matchesAutoTimestampParamName("srcNonce")).toBe(true);
    expect(matchesAutoTimestampParamName("MESSAGESEQUENCE")).toBe(true);
    expect(matchesAutoTimestampParamName("order_seq")).toBe(true);
  });

  it("returns false for empty or unrelated names", () => {
    expect(matchesAutoTimestampParamName("")).toBe(false);
    expect(matchesAutoTimestampParamName("salt")).toBe(false);
    expect(matchesAutoTimestampParamName(undefined)).toBe(false);
  });
});

describe("getCurrentUnixTimestampSeconds", () => {
  it("returns the current unix timestamp in seconds as a string", () => {
    vi.spyOn(Date, "now").mockReturnValue(1712641234123);

    expect(getCurrentUnixTimestampSeconds()).toBe("1712641234");

    Date.now.mockRestore();
  });
});
