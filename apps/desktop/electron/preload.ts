import { contextBridge, ipcRenderer } from "electron";

import type { AgentId, InstallOptions, PaymentChain } from "./core/types.js";

contextBridge.exposeInMainWorld("clawrouter", {
  statuses: () => ipcRenderer.invoke("agents:statuses"),
  install: (agent: AgentId, options?: InstallOptions) =>
    ipcRenderer.invoke("agents:install", agent, options),
  uninstall: (agent: AgentId) => ipcRenderer.invoke("agents:uninstall", agent),
  dashboard: () => ipcRenderer.invoke("dashboard:get"),
  switchPaymentChain: (chain: PaymentChain) => ipcRenderer.invoke("wallet:switch-chain", chain),
  createWallet: (chain: PaymentChain) => ipcRenderer.invoke("wallet:create", chain),
  adoptLegacyWallet: (chain: PaymentChain) => ipcRenderer.invoke("wallet:adopt-legacy", chain),
  createOnramp: (amount: number) => ipcRenderer.invoke("wallet:create-onramp", amount),
  openExternal: (url: string) => ipcRenderer.invoke("external:open", url),
});
