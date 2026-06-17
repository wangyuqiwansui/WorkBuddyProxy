const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  formatReasoningEffort,
  normalizeReasoningEffortValue,
  resolveReasoningEffort,
} = require("../lib/reasoningEffort");

test("reasoning effort options expose the four UI modes", () => {
  assert.deepEqual(REASONING_EFFORT_OPTIONS, [
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "超高" },
  ]);
  assert.equal(DEFAULT_REASONING_EFFORT, "medium");
});

test("resolveReasoningEffort uses request reasoning before configured default", () => {
  const result = resolveReasoningEffort(
    { reasoning: { effort: "xhigh" } },
    "low",
  );

  assert.deepEqual(result, {
    value: "xhigh",
    label: "超高",
    defaulted: false,
  });
  assert.equal(formatReasoningEffort(result), "超高");
});

test("resolveReasoningEffort falls back to configured default and marks it", () => {
  const result = resolveReasoningEffort({}, "high");

  assert.deepEqual(result, {
    value: "high",
    label: "高",
    defaulted: true,
  });
  assert.equal(formatReasoningEffort(result), "高(默认)");
});

test("resolveReasoningEffort defaults to medium when nothing is configured", () => {
  const result = resolveReasoningEffort({}, "");

  assert.deepEqual(result, {
    value: "medium",
    label: "中",
    defaulted: true,
  });
  assert.equal(formatReasoningEffort(result), "中(默认)");
});

test("resolveReasoningEffort accepts Chinese labels and top-level reasoning_effort", () => {
  assert.deepEqual(resolveReasoningEffort({ reasoning_effort: "超高" }, "medium"), {
    value: "xhigh",
    label: "超高",
    defaulted: false,
  });
  assert.deepEqual(resolveReasoningEffort({ reasoningEffort: "低" }, "medium"), {
    value: "low",
    label: "低",
    defaulted: false,
  });
});

test("normalizeReasoningEffortValue returns canonical values for settings", () => {
  assert.equal(normalizeReasoningEffortValue("超高"), "xhigh");
  assert.equal(normalizeReasoningEffortValue("very_high"), "xhigh");
  assert.equal(normalizeReasoningEffortValue("bad-value"), "");
});
