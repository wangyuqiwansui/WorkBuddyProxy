const els = {
  statusBadge: document.querySelector("#statusBadge"),
  modelText: document.querySelector("#modelText"),
  endpointText: document.querySelector("#endpointText"),
  loginText: document.querySelector("#loginText"),
  notice: document.querySelector("#notice"),
  modelSelect: document.querySelector("#modelSelect"),
  modelCount: document.querySelector("#modelCount"),
  loginButton: document.querySelector("#loginButton"),
  testButton: document.querySelector("#testButton"),
  refreshModelsButton: document.querySelector("#refreshModelsButton"),
  refreshBalanceButton: document.querySelector("#refreshBalanceButton"),
  proxyStatusText: document.querySelector("#proxyStatusText"),
  proxyHost: document.querySelector("#proxyHost"),
  proxyPort: document.querySelector("#proxyPort"),
  proxyApiUrl: document.querySelector("#proxyApiUrl"),
  proxyApiKey: document.querySelector("#proxyApiKey"),
  startProxyButton: document.querySelector("#startProxyButton"),
  stopProxyButton: document.querySelector("#stopProxyButton"),
  copyButton: document.querySelector("#copyButton"),
  proxyFields: document.querySelectorAll(".proxy-field"),
  logBox: document.querySelector("#logBox"),
};

let currentState = null;
let rendering = false;

function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  els.logBox.textContent += `[${time}] ${message}\n`;
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  if (busy) {
    button.dataset.oldText = button.textContent;
    button.textContent = text;
  } else if (button.dataset.oldText) {
    button.textContent = button.dataset.oldText;
    delete button.dataset.oldText;
  }
}

function render(state) {
  currentState = state;
  rendering = true;
  const account = state.account || {};
  const proxy = state.proxy || {};
  const selectedModel = state.selectedModel || state.models?.[0] || "-";
  els.statusBadge.textContent = account.loggedIn ? "已配置" : "未配置";
  els.modelText.textContent = `当前模型：${selectedModel}`;
  els.endpointText.textContent = `接口地址：${state.endpoint || "https://chatgpt.com/backend-api"}`;
  if (account.loggedIn) {
    els.loginText.textContent = `登录账号：${account.email || "已保存 OAuth 凭证"}，有效期至 ${account.expiresText || "未知"}`;
    els.notice.textContent = "已接通 OAuth 登录、模型运行时与连接测试链路。需要先完成浏览器登录后再使用。";
  } else {
    els.loginText.textContent = "登录账号：未登录";
    els.notice.textContent = "未接通 OAuth 登录。请点击“管理登录”完成浏览器登录。";
  }

  els.proxyStatusText.textContent = proxy.running ? "已开启，正在监听本地请求" : "未开启，WorkBuddy 暂时无法连接";
  els.proxyStatusText.classList.toggle("running", Boolean(proxy.running));
  els.proxyHost.textContent = proxy.host || "127.0.0.1";
  els.proxyPort.textContent = String(proxy.port || "");
  els.proxyApiUrl.textContent = proxy.apiUrl || "";
  els.proxyApiKey.textContent = proxy.apiKey || "";
  els.startProxyButton.disabled = Boolean(proxy.running);
  els.stopProxyButton.disabled = !proxy.running;

  els.modelSelect.innerHTML = "";
  for (const model of state.models || []) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selectedModel;
    els.modelSelect.appendChild(option);
  }
  els.modelCount.textContent = `下拉切换当前使用模型，共 ${(state.models || []).length} 个模型`;
  rendering = false;
}

async function loadState() {
  render(await window.workbuddy.getState());
}

async function runAction(button, busyText, action, successMessage) {
  setBusy(button, true, busyText);
  let result = null;
  try {
    result = await action();
    if (successMessage) appendLog(successMessage);
  } catch (error) {
    appendLog(error?.message || String(error));
    alert(error?.message || String(error));
  } finally {
    setBusy(button, false);
  }
  if (result?.models) render(result);
}

els.loginButton.addEventListener("click", () => {
  runAction(els.loginButton, "登录中...", () => window.workbuddy.login(), "Codex OAuth 登录完成。");
});

els.testButton.addEventListener("click", () => {
  runAction(els.testButton, "测试中...", () => window.workbuddy.testConnection(), "连接 GPT 成功。");
});

els.refreshModelsButton.addEventListener("click", () => {
  runAction(els.refreshModelsButton, "刷新中...", () => window.workbuddy.refreshModels());
});

els.refreshBalanceButton.addEventListener("click", () => {
  runAction(els.refreshBalanceButton, "刷新中...", () => window.workbuddy.refreshBalance());
});

els.startProxyButton.addEventListener("click", () => {
  runAction(els.startProxyButton, "开启中...", () => window.workbuddy.startProxy(), "WorkBuddy 代理已开启。");
});

els.stopProxyButton.addEventListener("click", () => {
  runAction(els.stopProxyButton, "停止中...", () => window.workbuddy.stopProxy(), "WorkBuddy 代理已停止。");
});

els.copyButton.addEventListener("click", () => {
  runAction(els.copyButton, "复制中...", () => window.workbuddy.copyConfig(), "WorkBuddy 配置已复制。");
});

function proxyCopyValue(field) {
  const proxy = currentState?.proxy || {};
  const key = field.dataset.copyField;
  const values = {
    host: proxy.host,
    port: proxy.port,
    apiUrl: proxy.apiUrl,
    apiKey: proxy.apiKey,
  };
  return values[key] == null ? "" : String(values[key]);
}

async function copyProxyField(field) {
  const value = proxyCopyValue(field);
  if (!value) return;
  try {
    await window.workbuddy.copyText(value);
    appendLog(`已复制：${field.querySelector("span")?.textContent || "代理字段"}`);
  } catch (error) {
    appendLog(error?.message || String(error));
  }
}

for (const field of els.proxyFields) {
  field.addEventListener("dblclick", () => copyProxyField(field));
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") copyProxyField(field);
  });
}

els.modelSelect.addEventListener("change", async () => {
  if (rendering) return;
  const model = els.modelSelect.value;
  try {
    render(await window.workbuddy.setModel(model));
  } catch (error) {
    appendLog(error?.message || String(error));
  }
});

window.workbuddy.onLog(appendLog);
loadState().catch((error) => appendLog(error?.message || String(error)));
