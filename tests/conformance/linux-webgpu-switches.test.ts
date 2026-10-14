/**
 * The Linux Studio's Chromium switches for WebGPU (`src/main/linux-webgpu.ts`): appended to the
 * command line before the app is ready, only on Linux and only when the owner's record approves
 * them. The record today is `linux-studio-webgpu: no` with no approval, so the Linux Studio
 * previews and judges a Rust · wgpu game through its native Linux build and nothing is appended.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLinuxWebGpuSwitches,
  LINUX_WEBGPU_APPROVAL,
  LINUX_WEBGPU_SWITCHES,
  LinuxWebGpuApproval,
  linuxWebGpuSwitches,
} from "../../src/main/linux-webgpu.ts";

/** A command line that records what was appended, as Electron's `app.commandLine` takes it. */
function recordingCommandLine() {
  const appended: Array<[string, string | undefined]> = [];
  return {
    appended,
    appendSwitch(name: string, value?: string) {
      appended.push([name, value]);
    },
  };
}

describe("the Linux Studio's WebGPU switches", () => {
  it("the owner has not approved them: the record is none, and the default appends nothing on Linux", () => {
    assert.equal(LINUX_WEBGPU_APPROVAL, LinuxWebGpuApproval.None);
    const line = recordingCommandLine();
    assert.equal(applyLinuxWebGpuSwitches(line, { platform: "linux" }), 0);
    assert.deepEqual(line.appended, []);
  });

  it("approved, Linux gets exactly the probed set, in order, each once", () => {
    const line = recordingCommandLine();
    const count = applyLinuxWebGpuSwitches(line, { platform: "linux", approval: LinuxWebGpuApproval.Switches });
    assert.equal(count, LINUX_WEBGPU_SWITCHES.length);
    assert.deepEqual(
      line.appended,
      LINUX_WEBGPU_SWITCHES.map((entry) => [entry.name, entry.value]),
    );
    assert.deepEqual(
      LINUX_WEBGPU_SWITCHES.map((entry) => (entry.value === undefined ? entry.name : `${entry.name}=${entry.value}`)),
      [
        "enable-unsafe-webgpu",
        "enable-features=Vulkan",
        "use-vulkan=swiftshader",
        "use-angle=swiftshader",
        "enable-unsafe-swiftshader",
        "ignore-gpu-blocklist",
      ],
    );
  });

  it("never on another platform, approved or not, whatever the platform string", () => {
    for (const platform of ["darwin", "win32", "Linux", "linux ", " linux", "", "freebsd", "linux\0"])
      for (const approval of Object.values(LinuxWebGpuApproval)) {
        const line = recordingCommandLine();
        assert.equal(
          applyLinuxWebGpuSwitches(line, { platform, approval }),
          0,
          `${JSON.stringify(platform)} ${approval}`,
        );
        assert.deepEqual(line.appended, [], `${JSON.stringify(platform)} ${approval}: nothing appended`);
        if (platform !== "linux") assert.deepEqual(linuxWebGpuSwitches(platform, approval), []);
      }
  });

  it("an approval that is not a known record appends nothing", () => {
    for (const hostile of ["yes", "SWITCHES", "", "switches ", null, undefined, 1, {}]) {
      assert.deepEqual(linuxWebGpuSwitches("linux", hostile), [], JSON.stringify(hostile) ?? "undefined");
    }
  });

  it("no switch in the set loosens the renderer's or the GPU process's sandbox", () => {
    const loosening = ["no-sandbox", "disable-gpu-sandbox", "in-process-gpu", "single-process", "no-zygote"];
    for (const entry of LINUX_WEBGPU_SWITCHES) assert.ok(!loosening.includes(entry.name), entry.name);
  });
});
