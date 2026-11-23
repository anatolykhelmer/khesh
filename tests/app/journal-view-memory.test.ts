import { describe, expect, it } from "vitest";
import {
  clearJournalView,
  forgetIfBare,
  JOURNAL_MONTH_KEY,
  JOURNAL_VIEW_KEY,
  readJournalView,
  writeJournalView,
} from "../../src/app/journal-view-memory";

const NOW = new Date(2026, 7, 12); // 12 August 2026
const MARCH = { year: 2026, month: 3 };
const AUGUST = { year: 2026, month: 8 }; // the current month at NOW

class MemoryStorage implements Storage {
  [name: string]: unknown;
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}

/** A store that refuses everything, as some private-browsing modes do. */
class BrokenStorage implements Storage {
  [name: string]: unknown;
  get length(): number {
    throw new Error("denied");
  }
  clear(): void {
    throw new Error("denied");
  }
  getItem(): string | null {
    throw new Error("denied");
  }
  key(): string | null {
    throw new Error("denied");
  }
  removeItem(): void {
    throw new Error("denied");
  }
  setItem(): void {
    throw new Error("denied");
  }
}

function freshStores() {
  return { local: new MemoryStorage(), session: new MemoryStorage() };
}

describe("readJournalView", () => {
  it("reads nothing remembered as no parameters", () => {
    expect(readJournalView(freshStores()).toString()).toBe("");
  });

  it("reads back an account and a past month", () => {
    const stores = freshStores();
    writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW);
    expect(readJournalView(stores).toString()).toBe("month=2026-03&account=cash");
  });

  it("reads all time as month=all and forgets the session month", () => {
    const stores = freshStores();
    writeJournalView({ period: MARCH, accountId: null }, stores, NOW);
    writeJournalView({ period: null, accountId: null }, stores, NOW);
    expect(readJournalView(stores).toString()).toBe("month=all");
    expect(stores.session.getItem(JOURNAL_MONTH_KEY)).toBeNull();
  });

  it("does not store the current month", () => {
    const stores = freshStores();
    writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW);
    writeJournalView({ period: AUGUST, accountId: "cash" }, stores, NOW);
    expect(stores.session.getItem(JOURNAL_MONTH_KEY)).toBeNull();
    expect(readJournalView(stores).toString()).toBe("account=cash");
  });

  it("opens a new session at no month but keeps the account", () => {
    const stores = freshStores();
    writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW);
    const nextLaunch = { local: stores.local, session: new MemoryStorage() };
    expect(readJournalView(nextLaunch).toString()).toBe("account=cash");
  });

  it("keeps all time across a new session", () => {
    const stores = freshStores();
    writeJournalView({ period: null, accountId: "cash" }, stores, NOW);
    const nextLaunch = { local: stores.local, session: new MemoryStorage() };
    expect(readJournalView(nextLaunch).toString()).toBe("month=all&account=cash");
  });

  it("reads unparsable or wrongly typed memory as nothing remembered", () => {
    for (const raw of ["{not json", "null", "42", '"text"', "[]", '{"accountId":7,"allTime":"yes"}']) {
      const stores = freshStores();
      stores.local.setItem(JOURNAL_VIEW_KEY, raw);
      expect(readJournalView(stores).toString(), raw).toBe("");
    }
  });

  it("keeps a well-typed field beside a wrongly typed one", () => {
    const stores = freshStores();
    stores.local.setItem(JOURNAL_VIEW_KEY, '{"accountId":"cash","allTime":"yes"}');
    expect(readJournalView(stores).toString()).toBe("account=cash");
  });

  it("passes a stored month through unvalidated, for parseYearMonthParam to judge", () => {
    const stores = freshStores();
    stores.session.setItem(JOURNAL_MONTH_KEY, "garbage");
    expect(readJournalView(stores).toString()).toBe("month=garbage");
  });
});

describe("writeJournalView", () => {
  it("still remembers the month when localStorage refuses", () => {
    const stores = { local: new BrokenStorage(), session: new MemoryStorage() };
    expect(() => writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW)).not.toThrow();
    expect(stores.session.getItem(JOURNAL_MONTH_KEY)).toBe("2026-03");
    expect(readJournalView(stores).toString()).toBe("month=2026-03");
  });

  it("still remembers the account when sessionStorage refuses", () => {
    const stores = { local: new MemoryStorage(), session: new BrokenStorage() };
    expect(() => writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW)).not.toThrow();
    expect(readJournalView(stores).toString()).toBe("account=cash");
  });

  it("treats missing stores as nothing remembered", () => {
    const stores = { local: null, session: null };
    expect(() => writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW)).not.toThrow();
    expect(readJournalView(stores).toString()).toBe("");
    expect(() => clearJournalView(stores)).not.toThrow();
  });
});

describe("clearJournalView", () => {
  it("forgets both the view and the month", () => {
    const stores = freshStores();
    writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW);
    clearJournalView(stores);
    expect(stores.local.getItem(JOURNAL_VIEW_KEY)).toBeNull();
    expect(stores.session.getItem(JOURNAL_MONTH_KEY)).toBeNull();
    expect(readJournalView(stores).toString()).toBe("");
  });

  it("does not throw on stores that refuse", () => {
    const stores = { local: new BrokenStorage(), session: new BrokenStorage() };
    expect(() => clearJournalView(stores)).not.toThrow();
  });
});

describe("forgetIfBare", () => {
  // A bare /journal means "return to the remembered view", so a write that leaves the
  // query string bare — Reset, or "All accounts" on ?account=X — must forget first, or
  // memory puts the old view straight back.
  it("forgets the view before a bare query string is written", () => {
    const stores = freshStores();
    writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW);
    forgetIfBare(new URLSearchParams(), stores);
    expect(readJournalView(stores).toString()).toBe("");
  });

  it("keeps the view when the query string still names a month or an account", () => {
    for (const raw of ["month=2026-03", "account=cash", "month=all"]) {
      const stores = freshStores();
      writeJournalView({ period: MARCH, accountId: "cash" }, stores, NOW);
      forgetIfBare(new URLSearchParams(raw), stores);
      expect(readJournalView(stores).toString(), raw).toBe("month=2026-03&account=cash");
    }
  });
});
