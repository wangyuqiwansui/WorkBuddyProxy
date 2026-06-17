const assert = require("node:assert/strict");
const test = require("node:test");

const {
  proxyErrorLog,
  proxyRequestLog,
  proxyResponseLog,
} = require("../lib/proxyLog");

test("proxyRequestLog summarizes inbound WorkBuddy requests without API keys", () => {
  const line = proxyRequestLog({
    requestId: "abc123",
    method: "POST",
    pathname: "/v1/chat/completions",
    payloadModel: "代理GPT",
    codexModel: "gpt-5.5",
    reasoningEffort: { value: "medium", label: "中", defaulted: true },
    stream: false,
    messageCount: 1,
  });

  assert.equal(line, "代理请求 abc123：POST /v1/chat/completions，WorkBuddy模型=代理GPT，Codex模型=gpt-5.5，推理=中(默认)，stream=false，messages=1");
  assert.equal(line.includes("Bearer"), false);
  assert.equal(line.includes("wbp-"), false);
});

test("proxyResponseLog shows success status, duration and output size", () => {
  assert.equal(
    proxyResponseLog({
      requestId: "abc123",
      status: 200,
      codexModel: "gpt-5.5",
      reasoningEffort: { value: "medium", label: "中", defaulted: true },
      textLength: 18,
      durationMs: 1234,
    }),
    "代理返回 abc123：HTTP 200，Codex模型=gpt-5.5，推理=中(默认)，输出=18 字符，耗时=1234ms",
  );
});

test("proxyErrorLog trims long errors", () => {
  const line = proxyErrorLog({
    requestId: "abc123",
    status: 502,
    durationMs: 7,
    error: "x".repeat(180),
  });

  assert.equal(line.length < 170, true);
  assert.equal(line.startsWith("代理错误 abc123：HTTP 502，耗时=7ms，"), true);
});
