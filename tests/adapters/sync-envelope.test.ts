import { decodeEnvelope, encodeEnvelope, SYNC_FORMAT } from "../../src/adapters/sync-envelope";
import { createBook } from "../../src/kernel/create-book";
import { EPOCH } from "../../src/kernel/normalize";
import { NOW, unwrap, unwrapErr } from "../helpers";

describe("sync envelope", () => {
  it("round-trips a v2 book", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const decoded = unwrap(decodeEnvelope(encodeEnvelope(book)));
    expect(decoded).toEqual(book);
  });

  it("declares format 1 and encrypted false", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const parsed = JSON.parse(encodeEnvelope(book));
    expect(parsed).toMatchObject({ app: "khesh", format: SYNC_FORMAT, encrypted: false });
  });

  it("accepts a v1 book inside the envelope and migrates it", () => {
    const raw = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 1, name: "Home", homeCurrency: "ILS", accounts: [], journal: [], budgets: [] },
    });
    const decoded = unwrap(decodeEnvelope(raw));
    expect(decoded.schemaVersion).toBe(2);
    expect(decoded.metaUpdatedAt).toBe(EPOCH);
  });

  it("rejects garbage and wrong shapes as SYNC_ENVELOPE_INVALID", () => {
    expect(unwrapErr(decodeEnvelope("{oops")).code).toBe("SYNC_ENVELOPE_INVALID");
    expect(unwrapErr(decodeEnvelope(JSON.stringify({ app: "other", format: 1, book: {} }))).code).toBe("SYNC_ENVELOPE_INVALID");
    const invalidBook = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 2, name: "", homeCurrency: "ILS", metaUpdatedAt: "x", accounts: [], journal: [], budgets: [], tombstones: [] },
    });
    expect(unwrapErr(decodeEnvelope(invalidBook)).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("treats the future as SYNC_FORMAT_UNSUPPORTED, not corruption", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const future = { app: "khesh", format: 2, encrypted: false, book };
    expect(unwrapErr(decodeEnvelope(JSON.stringify(future))).code).toBe("SYNC_FORMAT_UNSUPPORTED");
    const encrypted = { app: "khesh", format: 1, encrypted: true, book: "cipher" };
    expect(unwrapErr(decodeEnvelope(JSON.stringify(encrypted))).code).toBe("SYNC_FORMAT_UNSUPPORTED");
    const futureSchema = {
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { ...book, schemaVersion: 3 },
    };
    expect(unwrapErr(decodeEnvelope(JSON.stringify(futureSchema))).code).toBe("SYNC_FORMAT_UNSUPPORTED");
  });

  // --- Hardening: non-object parse results must be rejected before normalizeBook ---
  // sees them. normalizeBook and validateBook never throw on malformed *contents*, but
  // dereference straight through a non-object top level; decodeEnvelope is the only
  // caller that owes them that shape check, since every other caller pre-validates.

  it("rejects a null or bare-array envelope as SYNC_ENVELOPE_INVALID", () => {
    // `null` is a well-formed JSON document whose parsed value is not an object.
    expect(unwrapErr(decodeEnvelope("null")).code).toBe("SYNC_ENVELOPE_INVALID");
    // Already safe today (envelope.app on an array is undefined, which fails the app
    // check below) — pinned explicitly per the trust-boundary hardening requirement.
    expect(unwrapErr(decodeEnvelope(JSON.stringify([1, 2, 3]))).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("rejects a top-level string or number envelope as SYNC_ENVELOPE_INVALID", () => {
    expect(unwrapErr(decodeEnvelope(JSON.stringify("just a string"))).code).toBe("SYNC_ENVELOPE_INVALID");
    expect(unwrapErr(decodeEnvelope(JSON.stringify(5))).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("rejects an envelope whose book is null, a string, or a number as SYNC_ENVELOPE_INVALID", () => {
    const withBook = (book: unknown) =>
      JSON.stringify({ app: "khesh", format: 1, encrypted: false, book });
    expect(unwrapErr(decodeEnvelope(withBook(null))).code).toBe("SYNC_ENVELOPE_INVALID");
    expect(unwrapErr(decodeEnvelope(withBook("just a string"))).code).toBe("SYNC_ENVELOPE_INVALID");
    expect(unwrapErr(decodeEnvelope(withBook(5))).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("rejects a book with a non-array accounts or journal instead of throwing", () => {
    // Regression: normalizeBook's v1 migration path calls `.map` on `accounts`/
    // `journal` unconditionally. Without a shape check in front of it here, this
    // input reaches that `.map` and throws instead of returning an error Result.
    const v1WithNullAccounts = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 1, name: "Home", homeCurrency: "ILS", accounts: null, journal: [] },
    });
    expect(unwrapErr(decodeEnvelope(v1WithNullAccounts)).code).toBe("SYNC_ENVELOPE_INVALID");

    const v1WithNonArrayJournal = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 1, name: "Home", homeCurrency: "ILS", accounts: [], journal: "nope" },
    });
    expect(unwrapErr(decodeEnvelope(v1WithNonArrayJournal)).code).toBe("SYNC_ENVELOPE_INVALID");

    // Same hazard is reachable via a nominally-v2 book too: a malformed `tombstones`
    // sends normalizeBook down the same unguarded v1-style migration path.
    const v2WithMalformedTombstones = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: {
        schemaVersion: 2,
        name: "Home",
        homeCurrency: "ILS",
        metaUpdatedAt: NOW,
        accounts: null,
        journal: [],
        budgets: [],
        tombstones: "not-an-array",
      },
    });
    expect(unwrapErr(decodeEnvelope(v2WithMalformedTombstones)).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("rejects a null element inside accounts/journal/budgets instead of throwing", () => {
    // Regression: normalizeBook's v1 migration path maps `stamp` over every element,
    // and `stamp` dereferences `record.updatedAt` directly — a `null` element throws
    // there even though the array itself is a well-shaped array of the right length.
    const withNullAccount = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 1, name: "Home", homeCurrency: "ILS", accounts: [null], journal: [] },
    });
    expect(unwrapErr(decodeEnvelope(withNullAccount)).code).toBe("SYNC_ENVELOPE_INVALID");

    const withNullJournalEntry = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 1, name: "Home", homeCurrency: "ILS", accounts: [], journal: [null] },
    });
    expect(unwrapErr(decodeEnvelope(withNullJournalEntry)).code).toBe("SYNC_ENVELOPE_INVALID");

    const withNullBudget = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: { schemaVersion: 1, name: "Home", homeCurrency: "ILS", accounts: [], journal: [], budgets: [null] },
    });
    expect(unwrapErr(decodeEnvelope(withNullBudget)).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  // --- Hardening: every timestamp in the decoded book must be the exact fixed-width
  // form `toISOString()` produces, since mergeBooks compares them lexicographically. ---

  it("rejects a metaUpdatedAt carrying a UTC offset instead of Z as SYNC_ENVELOPE_INVALID", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    // Denotes 10:00 UTC (same instant as NOW) but sorts after it lexicographically.
    const offsetBook = { ...book, metaUpdatedAt: "2026-09-02T13:00:00.000+03:00" };
    const raw = JSON.stringify({ app: "khesh", format: 1, encrypted: false, book: offsetBook });
    expect(unwrapErr(decodeEnvelope(raw)).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("rejects a record updatedAt missing milliseconds as SYNC_ENVELOPE_INVALID", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const withAccount = {
      ...book,
      accounts: [
        {
          id: "a1",
          parentId: null,
          name: "Cash",
          type: "asset",
          currency: "ILS",
          isPlaceholder: false,
          // Valid ISO 8601, parses fine, but not the exact fixed-width shape.
          updatedAt: "2026-09-02T10:00:00Z",
        },
      ],
    };
    const raw = JSON.stringify({ app: "khesh", format: 1, encrypted: false, book: withAccount });
    expect(unwrapErr(decodeEnvelope(raw)).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("rejects a tombstone deletedAt carrying a UTC offset as SYNC_ENVELOPE_INVALID", () => {
    const book = unwrap(createBook({ name: "Home", homeCurrency: "ILS" }, NOW));
    const withTombstone = {
      ...book,
      tombstones: [
        {
          kind: "account",
          key: "a1",
          deletedAt: "2026-09-02T13:00:00.000+03:00",
          record: {
            id: "a1",
            parentId: null,
            name: "Old",
            type: "asset",
            currency: "ILS",
            isPlaceholder: false,
            updatedAt: NOW,
          },
        },
      ],
    };
    const raw = JSON.stringify({ app: "khesh", format: 1, encrypted: false, book: withTombstone });
    expect(unwrapErr(decodeEnvelope(raw)).code).toBe("SYNC_ENVELOPE_INVALID");
  });

  it("accepts a migrated v1 book whose EPOCH stamps are the canonical form", () => {
    // Guard against a regression where the canonical-timestamp check is stricter than
    // EPOCH itself and so rejects every migrated v1 book.
    const raw = JSON.stringify({
      app: "khesh",
      format: 1,
      encrypted: false,
      book: {
        schemaVersion: 1,
        name: "Home",
        homeCurrency: "ILS",
        accounts: [{ id: "a1", parentId: null, name: "Cash", type: "asset", currency: "ILS", isPlaceholder: false }],
        journal: [],
        budgets: [],
      },
    });
    const decoded = unwrap(decodeEnvelope(raw));
    expect(decoded.metaUpdatedAt).toBe(EPOCH);
    expect(decoded.accounts[0].updatedAt).toBe(EPOCH);
  });
});
