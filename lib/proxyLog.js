const { formatReasoningEffort } = require("./reasoningEffort");

function safeText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function trimError(value) {
  const text = safeText(value, "未知错误").replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function proxyRequestLog(input) {
  return [
    `代理请求 ${safeText(input.requestId)}：${safeText(input.method)} ${safeText(input.pathname)}`,
    `WorkBuddy模型=${safeText(input.payloadModel)}`,
    `Codex模型=${safeText(input.codexModel)}`,
    `推理=${formatReasoningEffort(input.reasoningEffort)}`,
    `stream=${Boolean(input.stream)}`,
    `messages=${Number(input.messageCount || 0)}`,
  ].join("，");
}

function proxyResponseLog(input) {
  return [
    `代理返回 ${safeText(input.requestId)}：HTTP ${Number(input.status || 200)}`,
    `Codex模型=${safeText(input.codexModel)}`,
    `推理=${formatReasoningEffort(input.reasoningEffort)}`,
    `输出=${Number(input.textLength || 0)} 字符`,
    `耗时=${Number(input.durationMs || 0)}ms`,
  ].join("，");
}

function proxyErrorLog(input) {
  return [
    `代理错误 ${safeText(input.requestId)}：HTTP ${Number(input.status || 500)}`,
    `耗时=${Number(input.durationMs || 0)}ms`,
    trimError(input.error),
  ].join("，");
}

module.exports = {
  proxyErrorLog,
  proxyRequestLog,
  proxyResponseLog,
};
