const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProxyState,
  ensureProxyConfig,
} = require("../lib/proxyState");

test("ensureProxyConfig generates a localhost port and proxy key when missing", () => {
  let requestedBytes = 0;
  const proxy = {};

  ensureProxyConfig(proxy, {
    randomBytes(size) {
      requestedBytes = size;
      return Buffer.from("proxy-test-key");
    },
  });

  assert.equal(proxy.host, "127.0.0.1");
  assert.equal(proxy.port, 8765);
  assert.equal(proxy.api_key, "wbp-cHJveHktdGVzdC1rZXk");
  assert.equal(requestedBytes, 32);
});

test("createProxyState exposes visible endpoint fields for the renderer", () => {
  const state = createProxyState(
    {
      host: "127.0.0.1",
      port: 9123,
      api_key: "wbp-visible",
    },
    true,
  );

  assert.deepEqual(state, {
    running: true,
    host: "127.0.0.1",
    port: 9123,
    baseUrl: "http://127.0.0.1:9123",
    apiUrl: "http://127.0.0.1:9123/v1",
    apiKey: "wbp-visible",
    authHeader: "Bearer wbp-visible",
  });
});
