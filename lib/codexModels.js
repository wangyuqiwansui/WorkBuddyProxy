const GPT_5_6_MODELS = [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

const DEFAULT_CODEX_MODELS = [
  ...GPT_5_6_MODELS,
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
];

const CODEX_CHATGPT_FALLBACK_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1"];

function mergeDefaultCodexModels(models) {
  const configured = Array.isArray(models) ? models : [];
  return [...DEFAULT_CODEX_MODELS, ...configured].reduce((result, model) => {
    const normalized = String(model || "").trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
    return result;
  }, []);
}

module.exports = {
  CODEX_CHATGPT_FALLBACK_MODELS,
  DEFAULT_CODEX_MODELS,
  GPT_5_6_MODELS,
  mergeDefaultCodexModels,
};
