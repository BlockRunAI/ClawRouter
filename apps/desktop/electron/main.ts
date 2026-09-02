import { app, BrowserWindow, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";

import { ClawRouterManager } from "./core/manager.js";
import {
  isTrustedRendererUrl,
  parseAgentId,
  parseExternalUrl,
  parseInstallOptions,
  parseOnrampAmount,
  parsePaymentChain,
} from "./core/ipc-policy.js";

let window: BrowserWindow | null = null;
let quitting = false;
const manager = new ClawRouterManager();
const rendererFile = join(__dirname, "../dist/index.html");

function requireTrustedRenderer(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl, rendererFile)) throw new Error("Untrusted renderer");
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#f4f4f3",
    show: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("ClawRouter renderer failed to load", { code, description, url });
  });
  window.webContents.on("did-finish-load", () => window?.show());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, rendererFile)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadFile(rendererFile);
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
}

function registerIpc() {
  ipcMain.handle("agents:statuses", (event) => {
    requireTrustedRenderer(event);
    return manager.statuses();
  });
  ipcMain.handle("agents:install", (event, agent: unknown, options?: unknown) => {
    requireTrustedRenderer(event);
    return manager.install(parseAgentId(agent), parseInstallOptions(options));
  });
  ipcMain.handle("agents:uninstall", (event, agent: unknown) => {
    requireTrustedRenderer(event);
    return manager.uninstall(parseAgentId(agent));
  });
  ipcMain.handle("dashboard:get", (event) => {
    requireTrustedRenderer(event);
    return manager.dashboard();
  });
  ipcMain.handle("wallet:switch-chain", (event, chain: unknown) => {
    requireTrustedRenderer(event);
    return manager.switchPaymentChain(parsePaymentChain(chain));
  });
  ipcMain.handle("wallet:create", (event, chain: unknown) => {
    requireTrustedRenderer(event);
    return manager.createWallet(parsePaymentChain(chain));
  });
  ipcMain.handle("wallet:adopt-legacy", (event, chain: unknown) => {
    requireTrustedRenderer(event);
    return manager.adoptLegacyWallet(parsePaymentChain(chain));
  });
  ipcMain.handle("wallet:create-onramp", (event, amount: unknown) => {
    requireTrustedRenderer(event);
    return manager.createOnramp(parseOnrampAmount(amount));
  });
  ipcMain.handle("external:open", (event, url: unknown) => {
    requireTrustedRenderer(event);
    return shell.openExternal(parseExternalUrl(url));
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = "system";
  registerIpc();
  createWindow();
  if (process.env.CLAWROUTER_DESKTOP_DISABLE_AUTOSTART !== "1") {
    manager.supervisor.ensureProxy().catch((error) => console.error("Proxy startup failed", error));
  }
});

app.on("activate", () => {
  if (window) window.show();
  else createWindow();
});

app.on("before-quit", () => {
  quitting = true;
  void manager.supervisor.stopAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
