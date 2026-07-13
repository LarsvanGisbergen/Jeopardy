"use strict";

const http = require("node:http");
const { app, BrowserWindow, dialog } = require("electron");
const { startServer, server } = require("./server/index.js");

const APP_PORT = Number(process.env.PORT || 8787);
const APP_URL = `http://127.0.0.1:${APP_PORT}/play`;

/**
 * @param {number} timeoutMs
 */
function waitForServer(timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`http://127.0.0.1:${APP_PORT}/api/packs`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for local server to start."));
        return;
      }
      setTimeout(attempt, 150);
    };

    attempt();
  });
}

function stopServer() {
  if (server.listening) server.close();
}

async function createWindow() {
  try {
    await startServer();
    await waitForServer();
  } catch (error) {
    dialog.showErrorBox("Failed to start Local Jeopardy server", String(error));
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: "#050f35",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL(APP_URL);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});
app.on("before-quit", stopServer);
