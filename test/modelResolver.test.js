const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveCodexModel } = require("../lib/modelResolver");

test("resolveCodexModel maps unknown WorkBuddy model names to the default Codex model", () => {
  const model = resolveCodexModel(
    {
      models: ["gpt-5.5", "gpt-5.4"],
      model_override: "",
    },
    "代理GPT",
  );

  assert.equal(model, "gpt-5.5");
});

test("resolveCodexModel keeps the selected UI model ahead of the WorkBuddy payload model", () => {
  const model = resolveCodexModel(
    {
      models: ["gpt-5.5", "gpt-5.4"],
      model_override: "gpt-5.4",
    },
    "代理GPT",
  );

  assert.equal(model, "gpt-5.4");
});

test("resolveCodexModel accepts a payload model only when it is in the Codex model list", () => {
  const model = resolveCodexModel(
    {
      models: ["gpt-5.5", "gpt-5.4"],
      model_override: "",
    },
    "gpt-5.4",
  );

  assert.equal(model, "gpt-5.4");
});
