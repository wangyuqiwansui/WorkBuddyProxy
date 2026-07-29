const DEFAULT_REASONING_EFFORT = "medium";

const REASONING_EFFORT_OPTIONS = [
  { value: "none", label: "无" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "最高" },
];

const ALL_REASONING_EFFORTS = [
  { value: "minimal", label: "最小" },
  ...REASONING_EFFORT_OPTIONS,
];

const ALIASES = new Map([
  ["none", "none"],
  ["无", "none"],
  ["minimal", "minimal"],
  ["min", "minimal"],
  ["最小", "minimal"],
  ["低", "low"],
  ["low", "low"],
  ["中", "medium"],
  ["medium", "medium"],
  ["med", "medium"],
  ["默认", "medium"],
  ["高", "high"],
  ["high", "high"],
  ["超高", "xhigh"],
  ["xhigh", "xhigh"],
  ["extrahigh", "xhigh"],
  ["veryhigh", "xhigh"],
  ["最高", "max"],
  ["极限", "max"],
  ["max", "max"],
  ["maximum", "max"],
  ["ultra", "max"],
]);

function normalizedKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function optionFor(value) {
  const key = normalizedKey(value);
  if (!key) return null;
  const normalized = ALIASES.get(key);
  if (!normalized) return null;
  return ALL_REASONING_EFFORTS.find((option) => option.value === normalized) || null;
}

function firstFilled(values) {
  return values.find((value) => String(value ?? "").trim());
}

function requestReasoningEffort(payload) {
  if (!payload || typeof payload !== "object") return "";
  return firstFilled([
    payload.reasoning?.effort,
    payload.reasoning_effort,
    payload.reasoningEffort,
    payload.extra_body?.reasoning?.effort,
    payload.extraBody?.reasoning?.effort,
  ]) || "";
}

function resolveReasoningEffort(payload = {}, configuredDefault = DEFAULT_REASONING_EFFORT) {
  const requested = optionFor(requestReasoningEffort(payload));
  if (requested) {
    return {
      value: requested.value,
      label: requested.label,
      defaulted: false,
    };
  }

  const fallback = optionFor(configuredDefault) || optionFor(DEFAULT_REASONING_EFFORT);
  return {
    value: fallback.value,
    label: fallback.label,
    defaulted: true,
  };
}

function normalizeReasoningEffortValue(value) {
  return optionFor(value)?.value || "";
}

function reasoningEffortForModel(model, value) {
  const normalized = normalizeReasoningEffortValue(value) || DEFAULT_REASONING_EFFORT;
  const modelId = String(model || "").trim().toLowerCase();
  const supportsMax = modelId === "gpt-5.6" || modelId.startsWith("gpt-5.6-");
  return normalized === "max" && !supportsMax ? "xhigh" : normalized;
}

function formatReasoningEffort(input) {
  if (!input || typeof input !== "object") return "-";
  const label = String(input.label || input.value || "").trim() || "-";
  return input.defaulted ? `${label}(默认)` : label;
}

module.exports = {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  formatReasoningEffort,
  normalizeReasoningEffortValue,
  reasoningEffortForModel,
  resolveReasoningEffort,
};
