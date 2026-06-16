const crypto = require("node:crypto");

const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 8765;

function normalizePort(value) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return DEFAULT_PROXY_PORT;
}

function createProxyKey(randomBytes = crypto.randomBytes) {
  return `wbp-${randomBytes(32).toString("base64url")}`;
}

function ensureProxyConfig(proxy, options = {}) {
  proxy.host = DEFAULT_PROXY_HOST;
  proxy.port = normalizePort(proxy.port);
  proxy.api_key ||= createProxyKey(options.randomBytes);
  return proxy;
}

function createProxyState(proxy, running) {
  const host = proxy.host || DEFAULT_PROXY_HOST;
  const port = normalizePort(proxy.port);
  const apiKey = proxy.api_key || "";
  const baseUrl = `http://${host}:${port}`;
  return {
    running: Boolean(running),
    host,
    port,
    baseUrl,
    apiUrl: `${baseUrl}/v1`,
    apiKey,
    authHeader: apiKey ? `Bearer ${apiKey}` : "",
  };
}

module.exports = {
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  createProxyKey,
  createProxyState,
  ensureProxyConfig,
  normalizePort,
};
