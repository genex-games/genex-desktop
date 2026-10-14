// A sandboxed Chromium page checking a real CppBuilds Web output, without loading the studio.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { app, BrowserWindow, nativeImage } = require("electron");

const [output, profile, evidence] = process.argv.slice(2);
assert.ok(output && profile && evidence);
app.setPath("userData", profile);
// The hosted runner has no GPU: Chromium blocklists WebGL2 on Xvfb, so the page draws through
// ANGLE's software SwiftShader backend (the evals prober's software mode). The app adds no switch.
const SOFTWARE_WEBGL = [
  ["use-gl", "angle"],
  ["use-angle", "swiftshader"],
  ["enable-unsafe-swiftshader", ""],
];
for (const [name, value] of SOFTWARE_WEBGL) app.commandLine.appendSwitch(name, value);
const report = {
  passed: false,
  electron: process.versions.electron,
  provider: "none",
  renderer: "software WebGL2 (ANGLE SwiftShader); no GPU on the runner",
};
const mime = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png" };
let server;
let window;
let finishing = false;
const deadline = setTimeout(() => finish(new Error("Browser acceptance exceeded 60 seconds")), 60_000);

async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) report.error = error.stack ?? String(error);
  await fs.writeFile(path.join(evidence, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
  window?.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  app.exit(error ? 1 : 0);
}

app
  .whenReady()
  .then(async () => {
    const root = await fs.realpath(output);
    server = http.createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const file = await fs.realpath(path.join(root, pathname === "/" ? "index.html" : pathname));
        assert.ok(file.startsWith(`${root}${path.sep}`));
        response.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
        response.end(await fs.readFile(file));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({
      width: 960,
      height: 640,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith("data:") }),
    );
    window.webContents.on("render-process-gone", (_event, details) =>
      finish(new Error(`Chromium stopped: ${details.reason}`)),
    );
    report.gpu = app.getGPUFeatureStatus();
    await window.loadURL(`${origin}/`);
    const readyUntil = Date.now() + 55_000;
    while (!(await window.webContents.executeJavaScript("typeof window.__studio?.capture === 'function'"))) {
      if (Date.now() > readyUntil) throw new Error("The actual C++ runtime did not become ready");
      await sleep(50);
    }
    const result = await window.webContents.executeJavaScript(`(async()=>{
    const api=window.__studio;
    const paused=api.pause(); const seeded=api.seed(7); const before=api.state();
    const step=api.step(100); const after=api.state();
    return {paused,seeded,step,before,after,capture:await api.capture()};
  })()`);
    const { assertStarterWitness } = await import("./cpp-linux-browser-witness.mjs");
    assertStarterWitness(result);
    assert.ok(result.capture?.startsWith("data:image/png;base64,"));
    const image = nativeImage.createFromDataURL(result.capture);
    assert.ok(!image.isEmpty());
    const size = image.getSize();
    assert.ok(size.width > 0 && size.height > 0);
    const pixels = image.toBitmap();
    const colors = new Set();
    for (let offset = 0; offset < pixels.length; offset += 4) colors.add(pixels.readUInt32LE(offset));
    assert.ok(colors.size > 1, "The actual rendered capture must contain game content");
    await fs.writeFile(path.join(evidence, "starter-web.png"), image.toPNG());
    Object.assign(report, {
      passed: true,
      paused: result.paused,
      seeded: result.seeded,
      step: result.step,
      before: result.before,
      after: result.after,
      capture: { file: "starter-web.png", ...size, colors: colors.size },
      sandbox: { rendererConfigured: window.webContents.getLastWebPreferences().sandbox, nodeIntegration: false },
    });
    await finish();
  })
  .catch(finish);
