function normalizeText(value) {
  return String(value || "").trim();
}

function resolveCodexModel(proxy, payloadModel) {
  const models = Array.isArray(proxy.models) ? proxy.models.filter(Boolean) : [];
  const selected = normalizeText(proxy.model_override);
  const requested = normalizeText(payloadModel);

  if (selected && models.includes(selected)) return selected;
  if (requested && models.includes(requested)) return requested;
  return models[0] || requested || selected || "";
}

module.exports = {
  resolveCodexModel,
};
