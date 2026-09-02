const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const svg = readFileSync(resolve("src/blockrun-app-icon.svg"), "utf8");
    const window = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true },
    });
    const document = `<!doctype html><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    mkdirSync(resolve("build"), { recursive: true });
    writeFileSync(resolve("build/icon.png"), image.toPNG());
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
