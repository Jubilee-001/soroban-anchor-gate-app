import assert from "node:assert";
import { describe, test } from "node:test";
import {
  EscrowRow,
  filterEscrows,
  sortEscrows,
  paginateEscrows,
  escrowRowsToCsv,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  PAGE_SIZE_OPTIONS,
} from "../components/EscrowTable";

const ROWS: EscrowRow[] = [
  { id: "E-001", recipient: "GAAAAA1111111111111111111111111111111111111111111111111111", token: "XLM", amount: 1000, status: "Funded", createdAt: "2026-01-10T10:00:00Z" },
  { id: "E-002", recipient: "GBBBBB2222222222222222222222222222222222222222222222222222", token: "USDC", amount: 500, status: "Disbursed", createdAt: "2026-01-15T12:00:00Z" },
  { id: "E-003", recipient: "GCCCCC3333333333333333333333333333333333333333333333333333", token: "XLM", amount: 2000, status: "Disputed", createdAt: "2026-02-01T09:00:00Z" },
  { id: "E-004", recipient: "GDDDDD4444444444444444444444444444444444444444444444444444", token: "USDC", amount: 750, status: "Refunded", createdAt: "2026-02-05T14:00:00Z" },
  { id: "E-005", recipient: "GEEEEE5555555555555555555555555555555555555555555555555555", token: "XLM", amount: 1500, status: "Funded", createdAt: "2026-03-01T08:00:00Z" },
];

describe("EscrowTable filter logic", () => {
  test("returns all rows when no filters are applied", () => {
    assert.strictEqual(filterEscrows(ROWS, DEFAULT_FILTERS).length, ROWS.length);
  });

  test("searches by escrow ID (case-insensitive)", () => {
    const result = filterEscrows(ROWS, { ...DEFAULT_FILTERS, search: "e-002" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "E-002");
  });

  test("searches by recipient address", () => {
    const result = filterEscrows(ROWS, { ...DEFAULT_FILTERS, search: "GCCCCC" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "E-003");
  });

  test("searches by token symbol", () => {
    const result = filterEscrows(ROWS, { ...DEFAULT_FILTERS, search: "usdc" });
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((row) => row.token === "USDC"));
  });

  test("search returns empty when nothing matches", () => {
    const result = filterEscrows(ROWS, { ...DEFAULT_FILTERS, search: "ZZZ" });
    assert.strictEqual(result.length, 0);
  });

  test("filters by status", () => {
    const result = filterEscrows(ROWS, { ...DEFAULT_FILTERS, status: "Funded" });
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((row) => row.status === "Funded"));
  });

  test("filters by Disputed status", () => {
    const result = filterEscrows(ROWS, { ...DEFAULT_FILTERS, status: "Disputed" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "E-003");
  });

  test("filters by date range", () => {
    const result = filterEscrows(ROWS, {
      ...DEFAULT_FILTERS,
      dateFrom: "2026-02-01",
      dateTo: "2026-02-05",
    });
    assert.strictEqual(result.length, 2);
    assert.ok(
      result.every(
        (row) =>
          row.createdAt.slice(0, 10) >= "2026-02-01" &&
          row.createdAt.slice(0, 10) <= "2026-02-05"
      )
    );
  });

  test("combines search, status, and date filters", () => {
    const result = filterEscrows(ROWS, {
      ...DEFAULT_FILTERS,
      search: "XLM",
      status: "Funded",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
    });
    assert.strictEqual(result.length, 2);
    assert.ok(result.every((row) => row.token === "XLM" && row.status === "Funded"));
  });

  test("handles empty row list", () => {
    assert.strictEqual(filterEscrows([], DEFAULT_FILTERS).length, 0);
    assert.strictEqual(filterEscrows([], { ...DEFAULT_FILTERS, status: "Funded" }).length, 0);
  });
});

describe("EscrowTable sort logic", () => {
  test("sorts by amount ascending", () => {
    const result = sortEscrows(ROWS, { field: "amount", dir: "asc" });
    assert.strictEqual(result[0].id, "E-002");
    assert.strictEqual(result[result.length - 1].id, "E-003");
  });

  test("sorts by amount descending", () => {
    const result = sortEscrows(ROWS, { field: "amount", dir: "desc" });
    assert.strictEqual(result[0].id, "E-003");
    assert.strictEqual(result[result.length - 1].id, "E-002");
  });

  test("sorts by date ascending", () => {
    const result = sortEscrows(ROWS, { field: "date", dir: "asc" });
    assert.strictEqual(result[0].id, "E-001");
    assert.strictEqual(result[result.length - 1].id, "E-005");
  });

  test("sorts by date descending", () => {
    const result = sortEscrows(ROWS, { field: "date", dir: "desc" });
    assert.strictEqual(result[0].id, "E-005");
    assert.strictEqual(result[result.length - 1].id, "E-001");
  });

  test("does not mutate the original array", () => {
    const original = [...ROWS].map((r) => r.id);
    sortEscrows(ROWS, { field: "amount", dir: "desc" });
    assert.deepStrictEqual(ROWS.map((r) => r.id), original);
  });
});

describe("EscrowTable pagination logic", () => {
  test("paginates page 1 with default page size 10", () => {
    const result = paginateEscrows(ROWS, 1, 10);
    assert.strictEqual(result.length, 5);
  });

  test("paginates across pages with page size 2", () => {
    const page1 = paginateEscrows(ROWS, 1, 2);
    const page2 = paginateEscrows(ROWS, 2, 2);
    const page3 = paginateEscrows(ROWS, 3, 2);
    assert.strictEqual(page1.length, 2);
    assert.strictEqual(page2.length, 2);
    assert.strictEqual(page3.length, 1);
    assert.strictEqual(page3[0].id, "E-005");
  });

  test("returns empty for a page beyond the last page", () => {
    const result = paginateEscrows(ROWS, 999, 10);
    assert.strictEqual(result.length, 0);
  });

  test("clamps non-positive page to page 1", () => {
    const result = paginateEscrows(ROWS, 0, 10);
    assert.strictEqual(result[0].id, "E-001");
  });

  test("PAGE_SIZE_OPTIONS contains 10, 25, 50", () => {
    assert.deepStrictEqual([...PAGE_SIZE_OPTIONS], [10, 25, 50]);
  });
});

describe("EscrowTable CSV export", () => {
  test("produces a header row plus one row per record", () => {
    const csv = escrowRowsToCsv(ROWS);
    const lines = csv.split("\n");
    assert.strictEqual(lines[0], "ID,Recipient,Token,Amount,Status,Created At");
    assert.strictEqual(lines.length, ROWS.length + 1);
  });

  test("escapes fields containing commas", () => {
    const rows: EscrowRow[] = [
      { ...ROWS[0], recipient: "G,quoted,address" },
    ];
    const csv = escrowRowsToCsv(rows);
    assert.ok(csv.includes('"G,quoted,address"'));
  });

  test("returns just the header for an empty list", () => {
    const csv = escrowRowsToCsv([]);
    assert.strictEqual(csv, "ID,Recipient,Token,Amount,Status,Created At");
  });

  test("DEFAULT_FILTERS and DEFAULT_SORT have expected shape", () => {
    assert.strictEqual(DEFAULT_FILTERS.status, "All");
    assert.strictEqual(DEFAULT_FILTERS.search, "");
    assert.strictEqual(DEFAULT_SORT.field, "date");
    assert.strictEqual(DEFAULT_SORT.dir, "desc");
  });
});
