import test from "node:test";
import assert from "node:assert/strict";
import { ascendingPersonalRecords, isEligiblePrRun } from "../js/pr-progress.js";

function run(partial) {
  return {
    id: partial.id,
    at: partial.at,
    maxKmh: partial.maxKmh,
    mode: partial.mode || "run",
    excludeFromPr: partial.excludeFromPr,
    analysis: { valid: partial.valid !== false, maxSpeedKmh: partial.maxKmh },
  };
}

test("ascendingPersonalRecords keeps only new highs in time order", () => {
  const points = ascendingPersonalRecords([
    run({ id: "c", at: "2026-03-01T10:00:00.000Z", maxKmh: 28 }),
    run({ id: "a", at: "2026-01-01T10:00:00.000Z", maxKmh: 22 }),
    run({ id: "b", at: "2026-02-01T10:00:00.000Z", maxKmh: 25 }),
    run({ id: "d", at: "2026-04-01T10:00:00.000Z", maxKmh: 24 }),
  ]);
  assert.deepEqual(
    points.map((p) => [p.id, p.maxKmh]),
    [
      ["a", 22],
      ["b", 25],
      ["c", 28],
    ]
  );
});

test("excluded and invalid runs are skipped so real PRs can surface", () => {
  const cleaned = ascendingPersonalRecords([
    run({ id: "friend", at: "2026-01-01T10:00:00.000Z", maxKmh: 40, excludeFromPr: true }),
    run({ id: "bad", at: "2026-01-15T10:00:00.000Z", maxKmh: 55, valid: false }),
    run({ id: "me1", at: "2026-02-01T10:00:00.000Z", maxKmh: 23 }),
    run({ id: "me2", at: "2026-03-01T10:00:00.000Z", maxKmh: 26 }),
  ]);
  assert.deepEqual(
    cleaned.map((p) => [p.id, p.maxKmh]),
    [
      ["me1", 23],
      ["me2", 26],
    ]
  );
  assert.equal(isEligiblePrRun(run({ id: "x", at: "2026-01-01", maxKmh: 20, excludeFromPr: true })), false);
});
