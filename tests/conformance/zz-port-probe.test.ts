// Temporary diagnostic for the 60080 EACCES report; removed before the PR is ready.
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { describe, it } from "node:test";

const SKIP = process.platform !== "win32" ? "Windows only" : false;

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (error) {
    return `ERR ${(error as Error).message}`;
  }
}

async function tryListen(port: number, host = "127.0.0.1"): Promise<string> {
  const server = net.createServer();
  try {
    server.listen(port, host);
    await once(server, "listening");
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error);
  } finally {
    server.close();
  }
}

async function holder(port: number, host: string) {
  const child = spawn(
    process.execPath,
    ["-e", `require('net').createServer().listen(${port}, '${host}', () => console.log('up'))`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  return child;
}

describe("port probe", { skip: SKIP }, () => {
  it("reports", async () => {
    console.log(sh("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"]));
    console.log(sh("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"]));
    console.log("free 60080:", await tryListen(60080));
    for (const host of ["127.0.0.1", "0.0.0.0"]) {
      const child = await holder(60080, host);
      console.log(`held by same user on ${host}:`, await tryListen(60080));
      child.kill();
      await once(child, "exit");
    }
    console.log(
      sh("netsh", ["int", "ipv4", "add", "excludedportrange", "protocol=tcp", "startport=60080", "numberofports=1"]),
    );
    console.log(sh("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"]));
    console.log("administered exclusion 60080:", await tryListen(60080), "60081:", await tryListen(60081));
    console.log(
      sh("netsh", ["int", "ipv4", "delete", "excludedportrange", "protocol=tcp", "startport=60080", "numberofports=1"]),
    );
    console.log("after delete 60080:", await tryListen(60080));
  });
});
