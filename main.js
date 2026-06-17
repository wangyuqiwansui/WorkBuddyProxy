const { app, BrowserWindow, clipboard, ipcMain, net, safeStorage, session, shell } = require("electron");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL, URLSearchParams } = require("node:url");
const { resolveCodexModel } = require("./lib/modelResolver");
const { proxyErrorLog, proxyRequestLog, proxyResponseLog } = require("./lib/proxyLog");
const { createProxyState, ensureProxyConfig } = require("./lib/proxyState");
const {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  normalizeReasoningEffortValue,
  resolveReasoningEffort,
} = require("./lib/reasoningEffort");
const {
  chatCompletionFromCodexResult,
  codexToolOptionsFromPayload,
  responseToolCallsFromResponse,
  responsesFromCodexResult,
} = require("./lib/toolBridge");

const APP_NAME = "WorkBuddyProxy";
const CONFIG_DIR = path.join(process.env.APPDATA || os.homedir(), APP_NAME);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const CODEX_AUTO_MODE = "codex_auto";
const DEFAULT_CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
];
const CODEX_CHATGPT_FALLBACK_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1"];
const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const CODEX_JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const LOCAL_PROXY_BYPASS_RULES = "localhost;127.0.0.1;::1;<-loopback>";

let mainWindow = null;
let config = loadConfig();
let proxyServer = null;
let proxyUrl = "";

function log(message) {
  mainWindow?.webContents.send("app:log", message);
}

function normalizeProxyUrl(value, defaultScheme = "http") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${defaultScheme}://${trimmed}`;
}

function readRegistryValue(name) {
  try {
    const output = execFileSync("reg", ["query", INTERNET_SETTINGS_KEY, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const line = output
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.startsWith(name));
    if (!line) return "";
    return line.split(/\s{2,}/)[2] || "";
  } catch {
    return "";
  }
}

function parseProxyServer(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return {};
  if (!proxy.includes("=")) {
    const url = normalizeProxyUrl(proxy);
    return { http: url, https: url };
  }
  return proxy.split(";").reduce((acc, part) => {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = rawKey.trim().toLowerCase();
    const rawValue = rawValueParts.join("=").trim();
    if ((key === "http" || key === "https" || key === "socks") && rawValue) {
      acc[key] = normalizeProxyUrl(rawValue, key === "socks" ? "socks5" : "http");
    }
    return acc;
  }, {});
}

function envValue(name) {
  return process.env[name] || process.env[name.toLowerCase()] || "";
}

function resolveProxySettings() {
  const httpProxy = normalizeProxyUrl(envValue("HTTP_PROXY"));
  const httpsProxy = normalizeProxyUrl(envValue("HTTPS_PROXY"));
  const allProxy = normalizeProxyUrl(envValue("ALL_PROXY"));
  if (httpProxy || httpsProxy) {
    return {
      source: "环境变量代理",
      http: httpProxy || httpsProxy,
      https: httpsProxy || httpProxy,
    };
  }
  if (allProxy) return { source: "环境变量代理", all: allProxy };

  if (process.platform !== "win32") return null;
  const enabled = readRegistryValue("ProxyEnable");
  if (!/^0x1$/i.test(enabled) && enabled !== "1") return null;
  const proxy = parseProxyServer(readRegistryValue("ProxyServer"));
  if (!proxy.http && !proxy.https && !proxy.socks) return null;
  if (!proxy.http && !proxy.https && proxy.socks) return { source: "Windows 系统代理", all: proxy.socks };
  return {
    source: "Windows 系统代理",
    http: proxy.http || proxy.https || "",
    https: proxy.https || proxy.http || "",
    socks: proxy.socks || "",
  };
}

function proxyRuleValue(value) {
  const url = new URL(normalizeProxyUrl(value));
  const scheme = url.protocol.replace(":", "").toLowerCase();
  const host = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
  const hostPort = `${host}${url.port ? `:${url.port}` : ""}`;
  if (scheme.startsWith("socks")) return `${scheme}://${hostPort}`;
  return hostPort;
}

function buildProxyRules(settings) {
  if (settings.all) return proxyRuleValue(settings.all);
  const rules = [];
  if (settings.http) rules.push(`http=${proxyRuleValue(settings.http)}`);
  if (settings.https) rules.push(`https=${proxyRuleValue(settings.https)}`);
  if (settings.socks) rules.push(`socks=${proxyRuleValue(settings.socks)}`);
  return rules.join(";");
}

async function configureNetworkProxy() {
  const settings = resolveProxySettings();
  const proxyConfig = settings
    ? { mode: "fixed_servers", proxyRules: buildProxyRules(settings), proxyBypassRules: LOCAL_PROXY_BYPASS_RULES }
    : { mode: "system", proxyBypassRules: LOCAL_PROXY_BYPASS_RULES };
  try {
    await app.setProxy(proxyConfig);
    await session.defaultSession.setProxy(proxyConfig);
    await session.defaultSession.forceReloadProxyConfig();
    log(settings ? `网络代理已启用：${settings.source}。` : "网络代理：使用系统代理。");
  } catch (error) {
    log(`网络代理配置失败：${error.message || error}`);
  }
}

async function codexFetch(url, options) {
  if (app.isReady() && net?.fetch) {
    return net.fetch(url, options);
  }
  return fetch(url, options);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function normalizeDefaultReasoningEffort(value) {
  const normalized = normalizeReasoningEffortValue(value);
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === normalized) ? normalized : DEFAULT_REASONING_EFFORT;
}

function proxyConfig() {
  config.proxy ||= {};
  const proxy = config.proxy;
  ensureProxyConfig(proxy);
  proxy.route_mode ||= CODEX_AUTO_MODE;
  proxy.upstream_base_url ||= "https://api.openai.com";
  proxy.models ||= DEFAULT_CODEX_MODELS;
  proxy.model_override ||= "";
  proxy.reasoning_effort = normalizeDefaultReasoningEffort(proxy.reasoning_effort);
  if (Array.isArray(proxy.models) && proxy.models[0]?.startsWith?.("gpt-5.3-codex")) {
    proxy.models = DEFAULT_CODEX_MODELS;
  }
  if (String(proxy.model_override || "").startsWith("gpt-5.3-codex")) {
    proxy.model_override = "";
  }
  return proxy;
}

function encryptSecret(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    return `plain:${Buffer.from(value, "utf8").toString("base64")}`;
  }
  return `safe:${safeStorage.encryptString(value).toString("base64")}`;
}

function decryptSecret(value) {
  if (!value || typeof value !== "string") return "";
  try {
    if (value.startsWith("safe:")) {
      return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
    }
    if (value.startsWith("plain:")) {
      return Buffer.from(value.slice(6), "base64").toString("utf8");
    }
  } catch {
    return "";
  }
  return "";
}

function saveCodexCredentials(accessToken, refreshToken, expiresAtMs) {
  const proxy = proxyConfig();
  proxy.codex_access_token = encryptSecret(accessToken);
  proxy.codex_refresh_token = encryptSecret(refreshToken);
  proxy.codex_expires_at = expiresAtMs;
  saveConfig();
}

function loadCodexCredentials() {
  const proxy = proxyConfig();
  return {
    accessToken: decryptSecret(proxy.codex_access_token),
    refreshToken: decryptSecret(proxy.codex_refresh_token),
    expiresAtMs: Number(proxy.codex_expires_at || 0),
  };
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT token.");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function extractCodexAccountId(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.[CODEX_JWT_AUTH_CLAIM]?.chatgpt_account_id;
  if (!accountId) throw new Error("无法从 Codex OAuth token 中解析账号 ID。");
  return String(accountId);
}

function extractCodexEmail(accessToken) {
  try {
    const payload = decodeJwtPayload(accessToken);
    return String(payload?.[CODEX_JWT_PROFILE_CLAIM]?.email || "");
  } catch {
    return "";
  }
}

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(challenge, state) {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CODEX_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return url.toString();
}

async function tokenRequest(params) {
  const response = await codexFetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI Codex OAuth 请求失败：HTTP ${response.status} ${text.slice(0, 400)}`);
  }
  const payload = JSON.parse(text);
  if (!payload.access_token || !payload.refresh_token || !payload.expires_in) {
    throw new Error("OpenAI Codex OAuth token 响应不完整。");
  }
  extractCodexAccountId(payload.access_token);
  return payload;
}

async function exchangeAuthorizationCode(code, verifier) {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
  });
}

async function refreshAccessToken(refreshToken) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
}

async function getAccessToken(forceRefresh = false) {
  let { accessToken, refreshToken, expiresAtMs } = loadCodexCredentials();
  if (!accessToken || !refreshToken) throw new Error("OpenAI Codex 尚未登录，请先点击“管理登录”。");
  if (forceRefresh || expiresAtMs <= Date.now() + 120_000) {
    const refreshed = await refreshAccessToken(refreshToken);
    saveCodexCredentials(
      refreshed.access_token,
      refreshed.refresh_token,
      Date.now() + Number(refreshed.expires_in) * 1000,
    );
    accessToken = refreshed.access_token;
  }
  return accessToken;
}

function accountDetails() {
  const { accessToken, expiresAtMs } = loadCodexCredentials();
  if (!accessToken) return { loggedIn: false, email: "", expiresText: "" };
  const email = extractCodexEmail(accessToken);
  const expiresText = expiresAtMs ? new Date(expiresAtMs).toLocaleString() : "未知";
  return { loggedIn: true, email, expiresText };
}

async function loginCodex() {
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(challenge, state);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400);
          res.end("State mismatch.");
          return;
        }
        const authCode = url.searchParams.get("code");
        if (!authCode) {
          res.writeHead(400);
          res.end("Missing authorization code.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("OpenAI Codex 登录完成，可以关闭此窗口。");
        server.close();
        resolve(authCode);
      } catch (error) {
        server.close();
        reject(error);
      }
    });
    server.once("error", reject);
    server.listen(1455, "127.0.0.1", () => {
      shell.openExternal(authUrl);
      log("正在打开 OpenAI Codex 登录页面。");
    });
    setTimeout(() => {
      server.close();
      reject(new Error("OpenAI Codex 登录等待超时。"));
    }, 180_000);
  });

  const token = await exchangeAuthorizationCode(code, verifier);
  saveCodexCredentials(
    token.access_token,
    token.refresh_token,
    Date.now() + Number(token.expires_in) * 1000,
  );
  return extractCodexEmail(token.access_token) || "OpenAI Codex";
}

function extractTextAndImages(content) {
  if (content == null) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };
  const texts = [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      texts.push(String(part));
      continue;
    }
    if (part.type === "text" || part.type === "input_text") {
      texts.push(String(part.text || ""));
    } else if (part.type === "image_url" || part.type === "input_image") {
      const imageUrl = typeof part.image_url === "object" ? part.image_url.url : part.image_url || part.url;
      if (imageUrl) images.push(String(imageUrl));
    } else if (part.text) {
      texts.push(String(part.text));
    }
  }
  return { text: texts.filter(Boolean).join("\n"), images };
}

function messagesToCodexInput(messages) {
  const developerParts = [];
  const transcriptParts = [];
  const imageUrls = [];
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user");
    const { text, images } = extractTextAndImages(message.content);
    imageUrls.push(...images);
    if (role === "system" || role === "developer") {
      if (text) developerParts.push(text);
      continue;
    }
    if (role === "assistant") {
      if (text) transcriptParts.push(`Assistant: ${text}`);
      for (const call of message.tool_calls || []) {
        const name = String(call?.function?.name || "").trim();
        const args = String(call?.function?.arguments || "{}");
        if (name) transcriptParts.push(`Assistant tool call ${call.id || ""}: ${name}(${args})`.trim());
      }
      continue;
    }
    if (role === "tool") {
      const toolLabel = String(message.name || message.tool_call_id || "Tool").trim();
      if (text) transcriptParts.push(`Tool ${toolLabel}: ${text}`);
      continue;
    }
    const label = { assistant: "Assistant", tool: "Tool", function: "Tool", user: "User" }[role] || role;
    if (text) transcriptParts.push(`${label}: ${text}`);
  }
  const prompt = transcriptParts.join("\n\n").trim() || "User:";
  const inputItems = [{ type: "text", text: prompt }];
  for (const url of imageUrls) inputItems.push({ type: "image", url });
  return { developerInstructions: developerParts.join("\n\n").trim(), inputItems };
}

function responseInputToCodexInput(payload) {
  const instructions = String(payload.instructions || "");
  const value = payload.input || "";
  if (typeof value === "string") return { developerInstructions: instructions, inputItems: [{ type: "text", text: value }] };
  if (Array.isArray(value)) {
    const textParts = [];
    const images = [];
    for (const item of value) {
      if (item && typeof item === "object") {
        const extracted = extractTextAndImages(item.content ?? item.text ?? item);
        if (extracted.text) textParts.push(extracted.text);
        images.push(...extracted.images);
      } else {
        textParts.push(String(item));
      }
    }
    return {
      developerInstructions: instructions,
      inputItems: [
        { type: "text", text: textParts.join("\n\n").trim() || "User:" },
        ...images.map((url) => ({ type: "image", url })),
      ],
    };
  }
  return { developerInstructions: instructions, inputItems: [{ type: "text", text: JSON.stringify(value) }] };
}

function buildCodexContext(developerInstructions, inputItems) {
  const content = [];
  for (const item of inputItems || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "image" && item.url) {
      content.push({ type: "input_image", detail: "auto", image_url: String(item.url) });
    } else if (item.text) {
      content.push({ type: "input_text", text: String(item.text) });
    }
  }
  return {
    instructions: developerInstructions?.trim() || "You are a helpful assistant. Follow the user's task instructions carefully and return the requested output.",
    messages: [{ role: "user", content: content.length ? content : [{ type: "input_text", text: "User:" }] }],
  };
}

async function parseSse(response, onEvent) {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
      if (data && data !== "[DONE]") {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Ignore malformed stream fragments.
        }
        if (parsed) onEvent(parsed);
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      const value = content?.text || content?.output_text;
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("");
}

function isUnsupportedModelError(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes("model is not supported") || message.includes("not supported when using codex with a chatgpt account");
}

async function runCodexWithModel(model, developerInstructions, inputItems, onDelta, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const effortValue = normalizeReasoningEffortValue(options.reasoningEffort?.value || options.reasoningEffort) || DEFAULT_REASONING_EFFORT;
  const toolOptions = options.toolOptions || {};
  const hasTools = Boolean(toolOptions.hasTools);
  const accessToken = await getAccessToken(forceRefresh);
  const accountId = extractCodexAccountId(accessToken);
  const { instructions, messages } = buildCodexContext(developerInstructions, inputItems);
  const body = {
    model,
    store: false,
    stream: true,
    instructions,
    input: messages,
    reasoning: { effort: effortValue },
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: hasTools ? toolOptions.tool_choice || "auto" : "none",
    parallel_tool_calls: hasTools ? Boolean(toolOptions.parallel_tool_calls) : false,
  };
  if (hasTools) body.tools = toolOptions.tools;
  const requestId = crypto.randomBytes(16).toString("hex");
  const response = await codexFetch(CODEX_BACKEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": "WorkBuddyProxy Electron",
      session_id: requestId,
      "x-client-request-id": requestId,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    if ((response.status === 401 || response.status === 403) && !forceRefresh) {
      return runCodexWithModel(model, developerInstructions, inputItems, onDelta, {
        reasoningEffort: effortValue,
        toolOptions,
        forceRefresh: true,
      });
    }
    throw new Error(`OpenAI Codex 后端请求失败：HTTP ${response.status} ${errorText.slice(0, 500)}`);
  }

  const chunks = [];
  let finalText = "";
  let finalResponse = null;
  const toolCallItems = [];
  await parseSse(response, (event) => {
    const type = String(event.type || "");
    if (type === "error") throw new Error(event.message || JSON.stringify(event));
    if (type === "response.failed") throw new Error(event.response?.error?.message || "OpenAI Codex response failed.");
    if (typeof event.delta === "string" && (type.includes("output_text") || type === "text_delta" || type === "response.text.delta")) {
      chunks.push(event.delta);
      onDelta?.(event.delta);
    }
    if ((type === "response.output_item.done" || type === "response.output_item.completed") && event.item?.type === "function_call") {
      toolCallItems.push(event.item);
    }
    if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      finalResponse = event.response || null;
      finalText = extractResponseText(event.response);
    }
  });
  const idFactory = () => `call_${crypto.randomBytes(12).toString("base64url")}`;
  const toolCalls = responseToolCallsFromResponse(finalResponse, idFactory);
  const fallbackToolCalls = toolCalls.length ? toolCalls : responseToolCallsFromResponse({ output: toolCallItems }, idFactory);
  return {
    model,
    text: chunks.join("").trim() || finalText.trim(),
    toolCalls: fallbackToolCalls,
  };
}

async function runCodex(model, developerInstructions, inputItems, onDelta, reasoningEffort, toolOptions) {
  const candidates = [];
  for (const candidate of [model, ...CODEX_CHATGPT_FALLBACK_MODELS]) {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (candidate !== model) log(`模型 ${model} 不受当前 ChatGPT Codex 账号支持，自动改用 ${candidate} 重试。`);
      return await runCodexWithModel(candidate, developerInstructions, inputItems, onDelta, { reasoningEffort, toolOptions });
    } catch (error) {
      lastError = error;
      if (!isUnsupportedModelError(error)) throw error;
    }
  }
  throw lastError || new Error("OpenAI Codex 未找到可用模型。");
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleProxyRequest(req, res) {
  const proxy = proxyConfig();
  const pathname = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`).pathname;
  const startedAt = Date.now();
  const requestId = crypto.randomBytes(4).toString("hex");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }
  if (pathname === "/health" || pathname === "/v1/health") {
    sendJson(res, 200, { status: "ok", mode: proxy.route_mode });
    return;
  }
  if (req.headers.authorization !== `Bearer ${proxy.api_key}`) {
    sendJson(res, 401, { error: { message: "Invalid proxy API key" } });
    return;
  }
  if (req.method === "GET" && pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: proxy.models.map((model) => ({ id: model, object: "model", owned_by: "codex-auto" })),
    });
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
    sendJson(res, 200, { id: pathname.replace("/v1/models/", ""), object: "model", owned_by: "codex-auto" });
    return;
  }
  if (req.method !== "POST" || !["/v1/chat/completions", "/v1/responses", "/v1/embeddings"].includes(pathname)) {
    sendJson(res, 404, { error: { message: "Unsupported endpoint" } });
    return;
  }
  if (pathname === "/v1/embeddings") {
    sendJson(res, 400, { error: { message: "Codex Auto mode does not provide embeddings." } });
    return;
  }
  try {
    const payload = JSON.parse((await readBody(req)) || "{}");
    const model = resolveCodexModel(proxy, payload.model);
    const reasoningEffort = resolveReasoningEffort(payload, proxy.reasoning_effort);
    const toolOptions = codexToolOptionsFromPayload(payload);
    const messageCount = Array.isArray(payload.messages) ? payload.messages.length : Array.isArray(payload.input) ? payload.input.length : 1;
    log(proxyRequestLog({
      requestId,
      method: req.method,
      pathname,
      payloadModel: payload.model,
      codexModel: model,
      reasoningEffort,
      stream: Boolean(payload.stream),
      messageCount,
    }));
    if (pathname === "/v1/chat/completions") {
      const { developerInstructions, inputItems } = messagesToCodexInput(payload.messages);
      if (payload.stream) {
        let streamedTextLength = 0;
        const completionId = `chatcmpl-${crypto.randomBytes(12).toString("base64url")}`;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "close",
          "Access-Control-Allow-Origin": "*",
        });
        const sendChunk = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        sendChunk({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
        const result = toolOptions.hasTools
          ? await runCodex(model, developerInstructions, inputItems, undefined, reasoningEffort, toolOptions)
          : await runCodex(model, developerInstructions, inputItems, (delta) => {
            streamedTextLength += String(delta || "").length;
            sendChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            });
          }, reasoningEffort, toolOptions);
        if (toolOptions.hasTools) {
          if (result.toolCalls.length) {
            sendChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: result.model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: result.toolCalls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: "function",
                    function: call.function,
                  })),
                },
                finish_reason: null,
              }],
            });
          } else if (result.text) {
            streamedTextLength += String(result.text).length;
            sendChunk({
              id: completionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: result.model,
              choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
            });
          }
        }
        sendChunk({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: result.model,
          choices: [{ index: 0, delta: {}, finish_reason: result.toolCalls.length ? "tool_calls" : "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        log(proxyResponseLog({
          requestId,
          status: 200,
          codexModel: result.model,
          reasoningEffort,
          textLength: result.toolCalls.length ? 0 : streamedTextLength,
          durationMs: Date.now() - startedAt,
        }));
        return;
      }
      const result = await runCodex(model, developerInstructions, inputItems, undefined, reasoningEffort, toolOptions);
      sendJson(res, 200, chatCompletionFromCodexResult(result, () => `chatcmpl-${crypto.randomBytes(12).toString("base64url")}`));
      log(proxyResponseLog({
        requestId,
        status: 200,
        codexModel: result.model,
        reasoningEffort,
        textLength: String(result.text || "").length,
        durationMs: Date.now() - startedAt,
      }));
      return;
    }

    const { developerInstructions, inputItems } = responseInputToCodexInput(payload);
    const result = await runCodex(model, developerInstructions, inputItems, undefined, reasoningEffort, toolOptions);
    sendJson(res, 200, responsesFromCodexResult(result, () => `resp_${crypto.randomBytes(12).toString("base64url")}`));
    log(proxyResponseLog({
      requestId,
      status: 200,
      codexModel: result.model,
      reasoningEffort,
      textLength: String(result.text || "").length,
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    log(proxyErrorLog({
      requestId,
      status: 502,
      durationMs: Date.now() - startedAt,
      error: error.message || error,
    }));
    sendJson(res, 502, { error: { message: `Proxy request failed: ${error.message || error}` } });
  }
}

function createProxyHttpServer() {
  return http.createServer((req, res) => {
    handleProxyRequest(req, res).catch((error) => sendJson(res, 500, { error: { message: String(error.message || error) } }));
  });
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function startProxy() {
  const proxy = proxyConfig();
  if (proxyServer) return createProxyState(proxy, true);

  const preferredPort = Number(proxy.port) || 8765;
  let lastError = null;
  for (let offset = 0; offset < 20; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65535) break;
    const server = createProxyHttpServer();
    try {
      await listenOnPort(server, port);
      proxyServer = server;
      proxy.port = port;
      saveConfig();
      const state = createProxyState(proxy, true);
      proxyUrl = state.apiUrl;
      log(`WorkBuddy 代理已启动：${state.apiUrl}`);
      return state;
    } catch (error) {
      lastError = error;
      try {
        server.close(() => {});
      } catch {
        // The server may never have reached the listening state.
      }
      if (error.code !== "EADDRINUSE") {
        throw new Error(`WorkBuddy 代理启动失败：${error.message || error}`);
      }
    }
  }
  throw new Error(`WorkBuddy 代理启动失败：端口 ${preferredPort}-${preferredPort + 19} 均不可用。${lastError?.message || ""}`);
}

async function stopProxy() {
  const proxy = proxyConfig();
  if (!proxyServer) return createProxyState(proxy, false);

  const server = proxyServer;
  proxyServer = null;
  proxyUrl = "";
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  log("WorkBuddy 代理已停止。");
  return createProxyState(proxy, false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    title: "WorkBuddy 代理助手",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function appState() {
  const proxy = proxyConfig();
  const details = accountDetails();
  const selectedModel = proxy.model_override || proxy.models[0];
  const proxyState = createProxyState(proxy, Boolean(proxyServer));
  return {
    account: details,
    models: proxy.models,
    selectedModel,
    reasoningEfforts: REASONING_EFFORT_OPTIONS,
    selectedReasoningEffort: proxy.reasoning_effort,
    endpoint: "https://chatgpt.com/backend-api",
    proxy: proxyState,
    proxyUrl: proxyState.apiUrl,
    apiKey: proxyState.apiKey,
  };
}

ipcMain.handle("app:getState", () => appState());

ipcMain.handle("app:login", async () => {
  const account = await loginCodex();
  log(`Codex OAuth 登录成功：${account}`);
  return appState();
});

ipcMain.handle("app:setModel", (_event, model) => {
  const proxy = proxyConfig();
  if (model && proxy.models.includes(model)) {
    proxy.model_override = model;
    saveConfig();
    log(`已切换模型：${model}`);
  }
  return appState();
});

ipcMain.handle("app:setReasoningEffort", (_event, effort) => {
  const proxy = proxyConfig();
  const value = normalizeReasoningEffortValue(effort);
  const option = REASONING_EFFORT_OPTIONS.find((item) => item.value === value);
  if (option) {
    proxy.reasoning_effort = option.value;
    saveConfig();
    log(`已切换默认推理模式：${option.label}`);
  }
  return appState();
});

ipcMain.handle("app:refreshModels", () => {
  const proxy = proxyConfig();
  proxy.models = DEFAULT_CODEX_MODELS;
  if (!proxy.models.includes(proxy.model_override)) proxy.model_override = proxy.models[0];
  saveConfig();
  log(`已同步 direct Codex 默认模型列表：${proxy.models.length} 个。`);
  return appState();
});

ipcMain.handle("app:testConnection", async () => {
  const proxy = proxyConfig();
  const model = proxy.model_override || proxy.models[0];
  const reasoningEffort = resolveReasoningEffort({}, proxy.reasoning_effort);
  const result = await runCodex(
    model,
    "You are a connectivity test endpoint. Reply with exactly OK.",
    [{ type: "text", text: "请只回复 OK，用于测试连接。" }],
    undefined,
    reasoningEffort,
  );
  const text = result.text;
  if (!text) throw new Error("Codex 已响应，但没有返回文本。");
  log(`测试连接成功：Codex 返回 ${text.slice(0, 40)}`);
  return { ok: true, text };
});

ipcMain.handle("app:copyConfig", () => {
  const proxy = proxyConfig();
  const proxyState = createProxyState(proxy, Boolean(proxyServer));
  const payload = {
    接口地址: proxyState.apiUrl,
    "API Key": proxyState.apiKey,
    模型: proxy.models,
    默认推理模式: proxy.reasoning_effort,
  };
  clipboard.writeText(JSON.stringify(payload, null, 2));
  log(proxyState.running ? "WorkBuddy 配置已复制到剪贴板。" : "WorkBuddy 配置已复制；代理当前未开启。");
  return appState();
});

ipcMain.handle("app:refreshBalance", () => {
  log("刷新余额：OpenAI Codex 暂未提供可程序化余额查询接口。");
  return { ok: true };
});

ipcMain.handle("app:startProxy", async () => {
  await startProxy();
  return appState();
});

ipcMain.handle("app:stopProxy", async () => {
  await stopProxy();
  return appState();
});

ipcMain.handle("app:copyText", (_event, value) => {
  const text = String(value || "");
  clipboard.writeText(text);
  log("已复制到剪贴板。");
  return { ok: true };
});

app.whenReady().then(async () => {
  proxyConfig();
  saveConfig();
  createWindow();
  await configureNetworkProxy();
});

app.on("window-all-closed", () => {
  proxyServer?.close();
  app.quit();
});
