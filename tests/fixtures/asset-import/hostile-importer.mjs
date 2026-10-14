// A stand-in for the importer that tries everything the importer's sandbox must refuse, then
// writes the one file it may (`out/proof.json`) with what happened. `rust-assets.test.ts` starts
// it through `importRustAssets` exactly as the real importer starts. Never run outside a test.
import { writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const job = process.argv[2] ?? "";
const attempt = (fn) => {
  try {
    fn();
    return "written";
  } catch (error) {
    return error.code ?? "refused";
  }
};
/** A GET through the sandbox's filtering proxy, for a reserved name: 403 is the proxy's refusal. */
const viaProxy = () =>
  new Promise((resolve) => {
    const proxy = new URL(process.env.HTTP_PROXY ?? process.env.http_proxy ?? "http://127.0.0.1:9");
    const user = decodeURIComponent(proxy.username);
    const auth = user ? { "proxy-authorization": `Basic ${Buffer.from(`${user}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {};
    const req = http.get(
      { host: proxy.hostname, port: proxy.port, path: "http://studio-import-probe.invalid/", headers: auth, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(`status:${res.statusCode}`);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve(error.code ?? "refused"));
  });
/** A direct TCP connection to TEST-NET-1 (no internet needed: the sandbox refuses it before any packet). */
const direct = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "192.0.2.1", port: 80, timeout: 3000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.on("error", (error) => resolve(error.code ?? "refused"));
  });

const proof = {
  game: attempt(() => writeFileSync(path.join(process.env.HOSTILE_GAME ?? "", "assets", "planted.txt"), "x")),
  sibling: attempt(() => writeFileSync(path.join(process.env.HOSTILE_SIBLING ?? "", "planted.txt"), "x")),
  jobsRoot: attempt(() => writeFileSync(path.join(job, "..", "planted.txt"), "x")),
  input: attempt(() => writeFileSync(path.join(job, "in", "0.obj"), "x")),
  jobFile: attempt(() => writeFileSync(path.join(job, "job.json"), "x")),
  proxy: await viaProxy(),
  direct: await direct(),
};
writeFileSync(path.join(job, "out", "proof.json"), JSON.stringify(proof));
