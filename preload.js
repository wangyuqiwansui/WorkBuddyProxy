const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbuddy", {
  getState: () => ipcRenderer.invoke("app:getState"),
  login: () => ipcRenderer.invoke("app:login"),
  setModel: (model) => ipcRenderer.invoke("app:setModel", model),
  setReasoningEffort: (effort) => ipcRenderer.invoke("app:setReasoningEffort", effort),
  refreshModels: () => ipcRenderer.invoke("app:refreshModels"),
  testConnection: () => ipcRenderer.invoke("app:testConnection"),
  copyConfig: () => ipcRenderer.invoke("app:copyConfig"),
  refreshBalance: () => ipcRenderer.invoke("app:refreshBalance"),
  startProxy: () => ipcRenderer.invoke("app:startProxy"),
  stopProxy: () => ipcRenderer.invoke("app:stopProxy"),
  copyText: (value) => ipcRenderer.invoke("app:copyText", value),
  onLog: (callback) => {
    ipcRenderer.on("app:log", (_event, message) => callback(message));
  },
});
