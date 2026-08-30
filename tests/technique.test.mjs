import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDurationMs,
  scoreTechniqueSession,
  buildTechniqueExport,
  buildMeasurementOutputs,
  techniqueWhatsAppSummary,
  techniqueChartPoints,
  techniqueHistoryRows,
  ascendingTechniqueTimeRecords,
  techniqueExecutionAccuracy,
  TECHNIQUE_RECORD_MIN_ACCURACY,
  conePositions,
  guessDeviceModelFromUa,
  detectDeviceModel,
  deviceInfo,
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

test("scoreTechniqueSession returns fixed 90% for completed pending_model sessions", () => {
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
  assert.equal(result.score, 90);
  assert.match(result.noteHe, /90%/);
});

test("scoreTechniqueSession returns null for too-short sessions", () => {
  const result = scoreTechniqueSession({
    motion: [{ t: 0, accMag: 10 }],
    durationMs: 500,
    exercise: { scoring: { status: "pending_model", modelId: null } },
  });
  assert.equal(result.score, null);
});

test("guessDeviceModelFromUa reads Android model tokens", () => {
  assert.equal(
    guessDeviceModelFromUa(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005) AppleWebKit/537.36"
    ),
    "Pixel 8"
  );
  assert.equal(guessDeviceModelFromUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), null);
});

test("detectDeviceModel uses client hints when available", async () => {
  const nav = {
    userAgent: "Mozilla/5.0",
    userAgentData: {
      platform: "Android",
      mobile: true,
      getHighEntropyValues: async () => ({ model: "Pixel 8 Pro", platformVersion: "14.0.0" }),
    },
  };
  const detected = await detectDeviceModel(nav);
  assert.equal(detected.model, "Pixel 8 Pro");
  assert.equal(detected.source, "ua_client_hints");
});

test("detectDeviceModel asks for user input when model is hidden", async () => {
  const detected = await detectDeviceModel({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  assert.equal(detected.model, null);
  assert.equal(detected.source, "unavailable");
  assert.equal(detected.family, "iPhone");
});

test("buildTechniqueExport packages all measurement streams and device model", () => {
  const exp = buildTechniqueExport({
    participantName: "משה",
    device: deviceInfo({ model: "Pixel 8", modelSource: "ua_client_hints" }),
    exercise: {
      id: "slalom_one_foot",
      name: "סלאלום רגל אחת",
      description: "עברו בין הקונוסים",
      coneLayout: { count: 10, spacingMeters: 1, pattern: "straight_line" },
    },
    durationMs: 8500,
    score: 72,
    scoreStatus: "pending_model",
    gps: [{ t: 1, speedKmh: 8, accuracy: 4, fusedSpeedKmh: 8.2 }],
    motion: [{ t: 1, accMag: 11, ax: 1, ay: 2, az: 9 }],
    fused: [{ t: 1, fusedSpeedKmh: 8.2 }],
    fusionDebug: { peakFusedKmh: 8.2 },
  });
  assert.equal(exp.schemaVersion, 2);
  assert.equal(exp.kind, "technique_session");
  assert.equal(exp.participantName, "משה");
  assert.equal(exp.device.model, "Pixel 8");
  assert.equal(exp.device.modelSource, "ua_client_hints");
  assert.equal(exp.exerciseId, "slalom_one_foot");
  assert.equal(exp.coneLayout.count, 10);
  assert.equal(exp.gps.length, 1);
  assert.equal(exp.motion.length, 1);
  assert.equal(exp.fused.length, 1);
  assert.equal(exp.measurements.gps.length, 1);
  assert.equal(exp.measurements.motion.length, 1);
  assert.equal(exp.measurements.fused.length, 1);
  assert.equal(exp.fusionDebug.peakFusedKmh, 8.2);
  assert.equal(exp.outputs.sampleCounts.gps, 1);
  assert.equal(exp.outputs.sampleCounts.motion, 1);
  assert.equal(exp.outputs.sampleCounts.fused, 1);
  assert.equal(exp.outputs.maxSpeedKmh, 8);
  assert.equal(exp.outputs.maxFusedSpeedKmh, 8.2);
  assert.match(techniqueWhatsAppSummary(exp), /משה/);
  assert.match(techniqueWhatsAppSummary(exp), /Pixel 8/);
  assert.match(techniqueWhatsAppSummary(exp), /72\/100/);
  assert.match(techniqueWhatsAppSummary(exp), /fused: 1/);
});

test("buildMeasurementOutputs summarizes peaks and sample counts", () => {
  const out = buildMeasurementOutputs({
    durationMs: 3000,
    score: 90,
    scoreStatus: "pending_model",
    gps: [
      { t: 1, speedKmh: 10, accuracy: 5 },
      { t: 2, speedKmh: 12, accuracy: 7 },
    ],
    motion: [{ t: 1 }, { t: 2 }, { t: 3 }],
    fused: [
      { t: 1, fusedSpeedKmh: 11 },
      { t: 2, fusedSpeedKmh: 13.4 },
    ],
  });
  assert.equal(out.sampleCounts.gps, 2);
  assert.equal(out.sampleCounts.motion, 3);
  assert.equal(out.sampleCounts.fused, 2);
  assert.equal(out.maxSpeedKmh, 12);
  assert.equal(out.maxFusedSpeedKmh, 13.4);
  assert.equal(out.meanGpsAccuracyM, 6);
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
    [
      ["d", 6.5],
      ["e", 6.4],
    ]
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

test("techniqueExecutionAccuracy uses provisional 90% for completed pending_model sessions", () => {
  assert.equal(techniqueExecutionAccuracy({ score: 40, scoreStatus: "pending_model", durationMs: 4000 }), 90);
  assert.equal(techniqueExecutionAccuracy({ score: 90, scoreStatus: "pending_model", durationMs: 4000 }), 90);
  assert.equal(techniqueExecutionAccuracy({ score: null, scoreStatus: "pending_model", durationMs: 500 }), 0);
  assert.equal(techniqueExecutionAccuracy({ durationMs: 4000 }), 90);
});

test("ascendingTechniqueTimeRecords includes legacy low-score pending_model sessions", () => {
  const sessions = [
    { id: "a", at: "2026-01-01T00:00:00.000Z", exerciseId: "slalom_one_foot", durationMs: 9000, score: 35, scoreStatus: "pending_model" },
    { id: "b", at: "2026-01-02T00:00:00.000Z", exerciseId: "slalom_one_foot", durationMs: 8500, score: 42, scoreStatus: "pending_model" },
  ];
  const records = ascendingTechniqueTimeRecords(sessions, "slalom_one_foot");
  assert.deepEqual(
    records.map((p) => p.id),
    ["a", "b"]
  );
});

test("ascendingTechniqueTimeRecords keeps only improving fastest times", () => {
  const sessions = [
    { id: "a", at: "2026-01-01T00:00:00.000Z", exerciseId: "slalom_one_foot", durationMs: 9000 },
    { id: "b", at: "2026-01-02T00:00:00.000Z", exerciseId: "slalom_one_foot", durationMs: 8500 },
    { id: "c", at: "2026-01-03T00:00:00.000Z", exerciseId: "slalom_one_foot", durationMs: 8600 },
    { id: "d", at: "2026-01-04T00:00:00.000Z", exerciseId: "slalom_two_feet", durationMs: 7000 },
  ];
  const records = ascendingTechniqueTimeRecords(sessions, "slalom_one_foot");
  assert.deepEqual(
    records.map((p) => [p.id, p.durationMs]),
    [
      ["a", 9000],
      ["b", 8500],
    ]
  );
  assert.equal(TECHNIQUE_RECORD_MIN_ACCURACY, 90);
});
