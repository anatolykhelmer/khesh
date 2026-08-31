import { describe, expect, it } from "vitest";
import {
  formatAccountBalance,
  formatDate,
  formatMinor,
  formatRate,
  monthLabel,
} from "../../src/app/format";

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

describe("formatMinor", () => {
  it("keeps sub-thousand output unchanged", () => {
    expect(formatMinor(0, "ILS")).toBe("0.00 ₪");
    expect(formatMinor(9520, "ILS")).toBe("95.20 ₪");
    expect(formatMinor(99999, "ILS")).toBe("999.99 ₪");
  });

  it("groups thousands with commas", () => {
    expect(formatMinor(120000, "ILS")).toBe("1,200.00 ₪");
    expect(formatMinor(123456789, "ILS")).toBe("1,234,567.89 ₪");
  });

  it("keeps the sign ahead of the grouped digits", () => {
    expect(formatMinor(-123456, "ILS")).toBe("-1,234.56 ₪");
  });

  it("keeps the sign when the integer part is zero", () => {
    // "-0.50" splits to whole "-0"; Number("-0") is -0 and Intl must render its sign.
    expect(formatMinor(-50, "ILS")).toBe("-0.50 ₪");
  });
});

describe("formatDate", () => {
  it("formats an ISO date in the current locale without shifting the day", () => {
    expect(formatDate("2026-08-13")).toBe("8/13/2026");
  });
});

describe("formatAccountBalance", () => {
  it("formats a leaf balance in its own currency", () => {
    expect(formatAccountBalance({ kind: "leaf", currency: "USD", amount: 12345 }, "ILS")).toBe(
      "123.45 $",
    );
  });

  it("puts the home currency first, then sorts the rest alphabetically", () => {
    expect(
      formatAccountBalance(
        { kind: "placeholder", balances: { USD: 100, EUR: 200, ILS: 300 } },
        "ILS",
      ),
    ).toBe("3.00 ₪ · 2.00 € · 1.00 $");
  });

  it("drops zero-balance currencies", () => {
    expect(
      formatAccountBalance({ kind: "placeholder", balances: { ILS: 500, USD: 0 } }, "ILS"),
    ).toBe("5.00 ₪");
  });

  it("shows a zero in the home currency when a group holds nothing", () => {
    expect(formatAccountBalance({ kind: "placeholder", balances: {} }, "ILS")).toBe("0.00 ₪");
  });
});
