import { bookToJson, jsonToBook } from "../../src/adapters/json-codec";
import { createAccount } from "../../src/kernel/accounts";
import { createBook } from "../../src/kernel/create-book";
import { postEntry } from "../../src/kernel/journal";
import { EPOCH } from "../../src/kernel/normalize";
import { NOW, unwrap, unwrapErr } from "../helpers";

describe("json codec", () => {
  it("round-trips a book", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Cash",
        type: "asset",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = unwrap(
      postEntry(book, {
        date: "2026-01-01",
        description: "X",
        postings: [
          { accountId: book.accounts[1].id, side: "debit", amount: 2 },
          { accountId: book.accounts[0].id, side: "credit", amount: 2 },
        ],
      }, NOW),
    );
    const parsed = unwrap(jsonToBook(bookToJson(book)));
    expect(parsed).toEqual(book);
  });

  it("rejects garbage JSON", () => {
    expect(unwrapErr(jsonToBook("not-json{")).code).toBe("JSON_PARSE_FAILED");
  });

  it("rejects wrong shape", () => {
    expect(unwrapErr(jsonToBook(JSON.stringify({ hello: 1 }))).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects schemaVersion 3", () => {
    const raw = JSON.stringify({
      schemaVersion: 3,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("BOOK_INVALID_SCHEMA_VERSION");
  });

  it("reports a v2 file with a null budget element instead of throwing", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      name: "Home",
      homeCurrency: "ILS",
      metaUpdatedAt: "2026-09-02T10:00:00.000Z",
      accounts: [],
      journal: [],
      budgets: [null],
      tombstones: [],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects null budget element in a v1 file", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [],
      budgets: [null],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects null budget element in a v2 file needing migration", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      name: "Home",
      homeCurrency: "ILS",
      metaUpdatedAt: 12345,
      accounts: [],
      journal: [],
      budgets: [null],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("accepts a v1 file and migrates it to v2 with EPOCH stamps", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [
        { id: "a1", parentId: null, name: "Food", type: "expense", currency: "ILS", isPlaceholder: false },
      ],
      journal: [],
      budgets: [{ accountId: "a1", period: "month", currency: "ILS", limit: 5 }],
    });
    const book = unwrap(jsonToBook(raw));
    expect(book.schemaVersion).toBe(2);
    expect(book.metaUpdatedAt).toBe(EPOCH);
    expect(book.accounts[0].updatedAt).toBe(EPOCH);
    expect(book.budgets[0].updatedAt).toBe(EPOCH);
    expect(book.tombstones).toEqual([]);
  });

  it("rejects journal entry without postings", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [{ id: "e1", date: "2026-01-01", description: "X", kind: "standard" }],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects null account element", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [null],
      journal: [],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects invalid entry kind", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [
        {
          id: "e1",
          date: "2026-01-01",
          description: "X",
          kind: "transfer",
          postings: [
            { accountId: "a", side: "debit", amount: 1 },
            { accountId: "b", side: "credit", amount: 1 },
          ],
        },
      ],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects invalid posting side", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [
        {
          id: "e1",
          date: "2026-01-01",
          description: "X",
          kind: "standard",
          postings: [
            { accountId: "a", side: "left", amount: 1 },
            { accountId: "b", side: "credit", amount: 1 },
          ],
        },
      ],
    });
    expect(unwrapErr(jsonToBook(raw)).code).toBe("JSON_INVALID_BOOK");
  });

  it("rejects invariant failures via validateBook", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [
        {
          id: "e1",
          date: "2026-01-01",
          description: "X",
          kind: "standard",
          postings: [
            { accountId: "missing", side: "debit", amount: 1 },
            { accountId: "also", side: "credit", amount: 1 },
          ],
        },
      ],
    });
    const error = unwrapErr(jsonToBook(raw));
    expect(error.code).toBe("BOOK_INVALID");
  });

  it("gives a pre-budget snapshot an empty budget list", () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      name: "Home",
      homeCurrency: "ILS",
      accounts: [],
      journal: [],
    });
    expect(unwrap(jsonToBook(legacy)).budgets).toEqual([]);
  });

  it("round-trips budgets", () => {
    let book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    book = unwrap(
      createAccount(book, {
        parentId: null,
        name: "Food",
        type: "expense",
        currency: "ILS",
        isPlaceholder: false,
      }, NOW),
    );
    book = {
      ...book,
      budgets: [
        {
          accountId: book.accounts[0].id,
          period: "month",
          currency: "ILS",
          limit: 400000,
          updatedAt: NOW,
        },
      ],
    };
    expect(unwrap(jsonToBook(bookToJson(book)))).toEqual(book);
  });
});
