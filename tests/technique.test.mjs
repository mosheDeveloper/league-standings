import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDurationMs,
  scoreTechniqueSession,
  buildTechniqueExport,
  techniqueWhatsAppSummary,
  techniqueChartPoints,
  techniqueHistoryRows,
  conePositions,
} from "../js/technique.js";

test("formatDurationMs pads minutes and tenths", () => {
  assert.equal(formatDurationMs(0), "00:00.0");
  assert.equal(formatDurationMs(12500), "00:12.5");
  assert.equal(formatDurationMs(61000), "01:01.0");
});

test("conePositions uses developer count and spacing", () => {
  const mapped = conePositions({ count: 10, spacingMeters: 1, pattern: "straight_line" });
  assert.equal(mapped.count, 10);
  assert.equal(mapped.spacingMeters, 1);
  assert.equal(mapped.totalLengthMeters, 9);
  assert.equal(mapped.positions.length, 10);
  assert.equal(mapped.positions[9].metersFromStart, 9);
});

test("scoreTechniqueSession is pending_model without modelId", () => {
  const motion = [];
  for (let i = 0; i < 20; i++) {
    motion.push({ t: i * 50, accMag: 9 + (i % 3) });
  }
  const result = scoreTechniqueSession({
    motion,
    durationMs: 4000,
    exercise: { scoring: { status: "pending_model", modelId: null } },
  });
  assert.equal(result.scoreStatus, "pending_model");
  assert.equal(typeof result.score, "number");
  assert.ok(result.score >= 0 && result.score <= 100);
});

test("buildTechniqueExport packages raw samples and participant name", () => {
  const exp = buildTechniqueExport({
    participantName: "משה",
    exercise: {
      id: "slalom_one_foot",
      name: "סלאלום רגל אחת",
      coneLayout: { count: 10, spacingMeters: 1, pattern: "straight_line" },
    },
    durationMs: 8500,
    score: 72,
    scoreStatus: "pending_model",
    gps: [{ t: 1, speedKmh: 8 }],
    motion: [{ t: 1, accMag: 11 }],
  });
  assert.equal(exp.kind, "technique_session");
  assert.equal(exp.participantName, "משה");
  assert.equal(exp.exerciseId, "slalom_one_foot");
  assert.equal(exp.coneLayout.count, 10);
  assert.equal(exp.gps.length, 1);
  assert.equal(exp.motion.length, 1);
  assert.match(techniqueWhatsAppSummary(exp), /משה/);
  assert.match(techniqueWhatsAppSummary(exp), /72\/100/);
});

test("technique exercises expose distinct demo youtube placeholders", async () => {
  const { readFileSync } = await import("node:fs");
  const catalog = JSON.parse(readFileSync(new URL("../data/technique-exercises.json", import.meta.url), "utf8"));
  const one = catalog.exercises.find((e) => e.id === "slalom_one_foot");
  const two = catalog.exercises.find((e) => e.id === "slalom_two_feet");
  assert.equal(one?.name, "סלאלום רגל אחת");
  assert.equal(two?.name, "סלאלום 2 רגליים");
  assert.equal(one?.demoVideo?.youtubeId, "JgtOMn5PFU0");
  assert.equal(two?.demoVideo?.youtubeId, "LXqPEpeokCg");
  assert.notEqual(one.demoVideo.youtubeId, two.demoVideo.youtubeId);
});

test("techniqueChartPoints filters by exercise, metric, and minScore", () => {
  const sessions = [
    { id: "a", at: "2026-01-01T00:00:00.000Z", exerciseId: "slalom_one_foot", score: 40, durationMs: 9000 },
    { id: "b", at: "2026-01-02T00:00:00.000Z", exerciseId: "slalom_two_feet", score: 55, durationMs: 8000 },
    { id: "c", at: "2026-01-03T00:00:00.000Z", exerciseId: "slalom_one_foot", score: 60, durationMs: 7000 },
    { id: "d", at: "2026-01-04T00:00:00.000Z", exerciseId: "slalom_one_foot", score: 91, durationMs: 6500 },
    { id: "e", at: "2026-01-05T00:00:00.000Z", exerciseId: "slalom_one_foot", score: 90, durationMs: 6400 },
  ];
  const scores = techniqueChartPoints(sessions, "slalom_one_foot", "score");
  assert.deepEqual(
    scores.map((p) => [p.id, p.value]),
    [
      ["a", 40],
      ["c", 60],
      ["d", 91],
      ["e", 90],
    ]
  );
  const times = techniqueChartPoints(sessions, "slalom_one_foot", "durationSec");
  assert.equal(times[0].value, 9);
  assert.equal(times[1].value, 7);

  const chartTimes = techniqueChartPoints(sessions, "slalom_one_foot", "durationSec", { minScore: 90 });
  assert.deepEqual(
    chartTimes.map((p) => [p.id, p.value]),
    [["d", 6.5]]
  );
});

test("techniqueHistoryRows returns newest first for an exercise", () => {
  const sessions = [
    { id: "a", at: "2026-01-01T00:00:00.000Z", exerciseId: "slalom_one_foot", score: 40, durationMs: 9000 },
    { id: "b", at: "2026-01-02T00:00:00.000Z", exerciseId: "slalom_two_feet", score: 55, durationMs: 8000 },
    { id: "c", at: "2026-01-03T00:00:00.000Z", exerciseId: "slalom_one_foot", score: 91, durationMs: 7000 },
  ];
  const rows = techniqueHistoryRows(sessions, "slalom_one_foot");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["c", "a"]
  );
});
