/**
 * Putting a Mac app an engine plugin's setup card installs (Unity Hub, Godot) into Applications:
 * only when Apple's Developer ID chain names the maker's team and Gatekeeper accepts it, copied
 * beside first and renamed into place, an older copy of the same app moved to the Trash (never
 * deleted), and a Stop honoured between the steps. The programs are the test's.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { AppInstallProblem, type AppRunner, placeApp, signedByTeam } from "../../src/substrate/app-install.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TEAM = "6K46PWY5DM";

/** What a fake Mac's codesign and spctl say about the app: whose team, and whether Apple's chain and Gatekeeper accept it. */
interface Signature {
  team?: string;
  developerId?: boolean;
  gatekeeper?: boolean;
}

/** A runner standing in for codesign, spctl and ditto: each call recorded, ditto copying the app's one file. */
function fakeMac(signature: Signature = {}) {
  const { team = TEAM, developerId = true, gatekeeper = true } = signature;
  const ran: string[][] = [];
  const run: AppRunner = async (command, args) => {
    ran.push([path.basename(command), ...args]);
    if (command.endsWith("codesign") && args.includes("--verify")) {
      const requirement = args.find((arg) => arg.startsWith("-R="));
      // A self-signed or ad hoc signature passes codesign's plain check; only a requirement refuses it.
      const meets = requirement?.includes("anchor apple generic") && requirement.includes(`"${team}"`);
      if (requirement && !(developerId && meets)) throw new Error("test-requirement: failed to satisfy");
    }
    if (args.includes("-dv")) return { out: "", err: `Identifier=org.example\nTeamIdentifier=${team}\n` };
    if (command.endsWith("spctl") && !gatekeeper) throw new Error("rejected");
    if (command.endsWith("ditto")) {
      await mkdir(args[1] ?? "", { recursive: true });
      await writeFile(path.join(args[1] ?? "", "version"), await readFile(path.join(args[0] ?? "", "version")));
    }
    return { out: "", err: "" };
  };
  return { run, ran };
}

/** A Mac's folders: the app to install (its one file says `version`), Applications and the Trash. */
async function folders(version = "new") {
  const root = await tmpDir("app-install-");
  const app = path.join(root, "unpacked", "Godot.app");
  const applications = path.join(root, "Applications");
  const trash = path.join(root, "home", ".Trash");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "version"), version);
  await mkdir(applications, { recursive: true });
  await mkdir(trash, { recursive: true });
  return { app, applications, trash, place: { applications, name: "Godot.app", team: TEAM, trash } };
}

const versionIn = (app: string) => readFile(path.join(app, "version"), "utf8");

describe("the maker's signature an installed app needs", () => {
  it("is Apple's Developer ID chain naming the maker's team, and Gatekeeper's yes", async () => {
    const mac = fakeMac();
    assert.equal(await signedByTeam(mac.run, "/x/Godot.app", TEAM), true);
    const verify = mac.ran.find((call) => call.includes("--verify")) ?? [];
    assert.ok(
      verify.some(
        (arg) =>
          arg.startsWith("-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists") &&
          arg.endsWith(`certificate leaf[subject.OU] = "${TEAM}"`),
      ),
      "codesign checks against Genex's own requirement, not the signer's",
    );
    assert.ok(mac.ran.some((call) => call[0] === "spctl" && call.includes("--assess")));
  });

  it("refuses a self-signed app, another team's, one Gatekeeper rejects, and a team that isn't one", async () => {
    const refused: Array<[string, Signature | undefined, string]> = [
      ["a self-signed certificate naming the team", { developerId: false }, TEAM],
      ["another team's Developer ID", { team: "ABCDE12345" }, TEAM],
      ["one Gatekeeper rejects", { gatekeeper: false }, TEAM],
      ["a team that would change the requirement", undefined, `${TEAM}" or anchor trusted or "`],
    ];
    for (const [what, signature, team] of refused) {
      const mac = fakeMac(signature);
      assert.equal(await signedByTeam(mac.run, "/x/Godot.app", team), false, what);
    }
  });
});

describe("putting an app into Applications", () => {
  it("copies it beside under another name and renames it into place", async () => {
    const mac = fakeMac();
    const where = await folders();
    await placeApp(mac.run, where.app, where.place);
    assert.deepEqual(await readdir(where.applications), ["Godot.app"]);
    assert.equal(await versionIn(path.join(where.applications, "Godot.app")), "new");
    const copy = mac.ran.find((call) => call[0] === "ditto") ?? [];
    assert.notEqual(copy[2], path.join(where.applications, "Godot.app"), "never copied straight into place");
  });

  it("moves an older copy of the app to the Trash once the new one is whole, and keeps what the Trash holds", async () => {
    const mac = fakeMac();
    const where = await folders();
    const older = path.join(where.applications, "Godot.app");
    await mkdir(older);
    await writeFile(path.join(older, "version"), "older");
    await mkdir(path.join(where.trash, "Godot.app"));
    await writeFile(path.join(where.trash, "Godot.app", "version"), "oldest");
    await placeApp(mac.run, where.app, where.place);
    assert.deepEqual(await readdir(where.applications), ["Godot.app"]);
    assert.equal(await versionIn(older), "new");
    assert.deepEqual((await readdir(where.trash)).sort(), ["Godot 2.app", "Godot.app"]);
    assert.equal(
      await versionIn(path.join(where.trash, "Godot 2.app")),
      "older",
      "the person's old app is recoverable",
    );
    assert.equal(await versionIn(path.join(where.trash, "Godot.app")), "oldest");
  });

  it("leaves the older app where it was when it can't be moved aside, and removes the copy", async () => {
    const mac = fakeMac();
    const where = await folders();
    const older = path.join(where.applications, "Godot.app");
    await mkdir(older);
    await writeFile(path.join(older, "version"), "older");
    const place = { ...where.place, trash: path.join(where.trash, "missing") };
    await assert.rejects(placeApp(mac.run, where.app, place), (error: { problem?: string }) => {
      return error.problem === AppInstallProblem.Copy;
    });
    assert.deepEqual(await readdir(where.applications), ["Godot.app"], "no half copy is left");
    assert.equal(await versionIn(older), "older");
  });

  it("copies nothing a self-signed certificate signed", async () => {
    const mac = fakeMac({ developerId: false });
    const where = await folders();
    await assert.rejects(placeApp(mac.run, where.app, where.place), (error: { problem?: string }) => {
      return error.problem === AppInstallProblem.NotSigned;
    });
    assert.ok(!mac.ran.some((call) => call[0] === "ditto"));
    assert.deepEqual(await readdir(where.applications), []);
  });

  it("stops between its steps once Stop is pressed, leaving Applications as it was", async () => {
    const stop = new AbortController();
    const mac = fakeMac();
    const run: AppRunner = async (command, args, timeoutMs, signal) => {
      const answer = await mac.run(command, args, timeoutMs, signal);
      if (command.endsWith("ditto")) stop.abort();
      return answer;
    };
    const where = await folders();
    await assert.rejects(placeApp(run, where.app, where.place, stop.signal));
    assert.deepEqual(await readdir(where.applications), []);
  });
});
