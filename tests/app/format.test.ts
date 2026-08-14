import { describe, expect, it } from "vitest";
import { formatDate, formatRate, monthLabel } from "../../src/app/format";

describe("formatRate", () => {
  it("expresses the quote currency per one unit of the base currency", () => {
    expect(
      formatRate({
        baseCurrency: "USD",
        baseAmount: 10000,
        quoteCurrency: "EUR",
        quoteAmount: 9240,
      }),
    ).toBe("1 USD = 0.9240 EUR");
  });

  it("rounds to four decimals", () => {
    expect(
      formatRate({
        baseCurrency: "USD",
        baseAmount: 30000,
        quoteCurrency: "ILS",
        quoteAmount: 111111,
      }),
    ).toBe("1 USD = 3.7037 ILS");
  });
});

describe("monthLabel", () => {
  it("returns the English month name for each month index", () => {
    expect(monthLabel(1)).toBe("January");
    expect(monthLabel(8)).toBe("August");
    expect(monthLabel(12)).toBe("December");
  });
});

describe("formatDate", () => {
  it("formats an ISO date in the current locale without shifting the day", () => {
    expect(formatDate("2026-08-13")).toBe("8/13/2026");
  });
});
