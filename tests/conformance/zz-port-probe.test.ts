// Temporary diagnostic for the 60080 EACCES report; removed before the PR is ready.
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { describe, it } from "node:test";

const SKIP = process.platform !== "win32" ? "Windows only" : false;

function ps(script: string): string {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
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

const RESERVE = `
Add-Type -Namespace P -Name R -MemberDefinition @'
[DllImport("iphlpapi.dll")] public static extern uint CreatePersistentTcpPortReservation(ushort StartPort, ushort NumberOfPorts, out ulong Token);
[DllImport("iphlpapi.dll")] public static extern uint DeletePersistentTcpPortReservation(ushort StartPort, ushort NumberOfPorts);
'@
`;
const swap = (port: number) => ((port & 0xff) << 8) | (port >> 8);

async function exclusiveHolder(host: string) {
  const script = `$s = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp); $s.ExclusiveAddressUse = $true; $s.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse('${host}'), 60080))); $s.Listen(1); 'up'; Start-Sleep 60`;
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout, "data");
  return child;
}

describe("port probe 2", { skip: SKIP }, () => {
  it("reports", async () => {
    for (const host of ["0.0.0.0", "127.0.0.1"]) {
      const child = await exclusiveHolder(host);
      console.log(`exclusive holder on ${host}: 127.0.0.1 ->`, await tryListen(60080));
      child.kill();
      await once(child, "exit");
    }
    console.log(
      "persistent reservation:",
      ps(`${RESERVE} $t=0; [P.R]::CreatePersistentTcpPortReservation(${swap(60080)}, 10, [ref]$t)`),
    );
    console.log(ps("netsh int ipv4 show excludedportrange protocol=tcp"));
    console.log("reserved 60080:", await tryListen(60080), "60089:", await tryListen(60089), "60090:", await tryListen(60090));
    console.log("delete:", ps(`${RESERVE} [P.R]::DeletePersistentTcpPortReservation(${swap(60080)}, 10)`));
    console.log("after delete 60080:", await tryListen(60080));
  });
});
