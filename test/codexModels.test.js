const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CODEX_CHATGPT_FALLBACK_MODELS,
  DEFAULT_CODEX_MODELS,
  GPT_5_6_MODELS,
  mergeDefaultCodexModels,
} = require("../lib/codexModels");

test("default Codex catalog exposes every GPT-5.6 model first", () => {
  assert.deepEqual(DEFAULT_CODEX_MODELS.slice(0, GPT_5_6_MODELS.length), [
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
});

test("catalog migration adds new defaults while preserving configured models", () => {
  const models = mergeDefaultCodexModels(["gpt-5.5", "custom-model", "gpt-5.6", ""]);

  assert.deepEqual(models.slice(0, GPT_5_6_MODELS.length), GPT_5_6_MODELS);
  assert.equal(models.filter((model) => model === "gpt-5.5").length, 1);
  assert.equal(models.filter((model) => model === "gpt-5.6").length, 1);
  assert.equal(models.at(-1), "custom-model");
});

test("fallback models are all present in the visible catalog", () => {
  for (const model of CODEX_CHATGPT_FALLBACK_MODELS) {
    assert.ok(DEFAULT_CODEX_MODELS.includes(model));
  }
});
