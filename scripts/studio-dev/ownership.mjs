import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeChild, readVersion, writeJson } from "./files.mjs";
import { gamesRootWarnings } from "./live-env.ts";
export function slug(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value ?? ""))
    throw new Error("profile/build ID must be a lowercase slug (1–48 characters)");
  return value;
}
export function devRoot(checkout) {
  const root = safeChild(checkout, ".studio-dev");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const d of ["profiles", "builds", "owners", "evidence"])
    fs.mkdirSync(safeChild(root, d), { recursive: true, mode: 0o700 });
  return root;
}
export function profilePath(checkout, id) {
  return safeChild(devRoot(checkout), `profiles/${slug(id)}`);
}
export function validateProfile(checkout, id) {
  const root = devRoot(checkout),
    dir = profilePath(checkout, id),
    owner = readVersion(safeChild(dir, "owner.json"));
  const registry = readVersion(safeChild(root, `owners/${id}.json`));
  if (
    owner.ownerId !== registry.ownerId ||
    owner.checkout !== fs.realpathSync(checkout) ||
    owner.profileId !== id ||
    owner.root !== dir ||
    registry.root !== dir
  )
    throw new Error("unrecognized or copied profile ownership");
  for (const [k, rel] of Object.entries(ownedRoots(owner)))
    if (owner[k] !== safeChild(dir, rel)) throw new Error(`invalid owned ${k} root`);
  if (!ownsGamesRoot(owner, dir)) throw new Error("invalid owned games root");
  const freshMachine = owner.freshMachine === true;
  if (freshMachine && owner.home !== freshMachineHome(owner.ownerId)) throw new Error("invalid owned home root");
  const validFresh = owner.freshMachine === undefined || (freshMachine && owner.providers === "live");
  if (
    !["fixture", "live"].includes(owner.providers) ||
    !validFresh ||
    owner.retention !== retentionOf(owner.providers, freshMachine)
  )
    throw new Error("invalid provider/retention identity");
  return owner;
}
/**
 * The folders inside a profile it owns, by owner field. A fresh-machine profile also owns the
 * folder Claude Code's Keychain item is named after; the owner id in that name makes a recreated
 * profile a new account to the Keychain too.
 */
function ownedRoots(owner) {
  const roots = { electron: "electron", session: "session", core: "core" };
  if (owner.freshMachine !== true) return roots;
  return { ...roots, secureStorage: `secure-storage-${owner.ownerId}` };
}
/** Whether `owner.games` is the root this profile was given: inside it, or outside for a live one ({@link outsideGamesRoot}). */
function ownsGamesRoot(owner, dir) {
  if (owner.gamesOutside === undefined) return owner.games === safeChild(dir, "games");
  const outsideAllowed = owner.gamesOutside === true && owner.providers === "live" && owner.freshMachine !== true;
  return outsideAllowed && owner.games === outsideGamesRoot(owner.ownerId);
}
/**
 * A live profile's games when its checkout sits under a `.claude` folder (a worktree there):
 * outside it in the home folder, where Claude Code's native Write neither refuses nor asks about
 * every game file the in-app agent writes. Named by the owner id, so it is this profile's alone.
 */
export function outsideGamesRoot(ownerId) {
  if (!/^[0-9a-f-]{36}$/.test(ownerId ?? "")) throw new Error("invalid owner id");
  return path.join(os.homedir(), "Genex Studio Dev", ownerId, "games");
}
/**
 * Whether a new profile keeps its games outside the checkout: a live one whose own games root is
 * under `.claude`. Not a fresh machine's, whose app runs with another home than this script's.
 */
function gamesGoOutside(providers, freshMachine, dir) {
  return providers === "live" && !freshMachine && gamesRootWarnings(path.join(dir, "games")).length > 0;
}
/**
 * A fresh-machine profile's home: in the temporary folder, outside the checkout, because the app
 * never takes a coding CLI from inside its own checkout and the CLIs install into this home.
 */
export function freshMachineHome(ownerId) {
  if (!/^[0-9a-f-]{36}$/.test(ownerId ?? "")) throw new Error("invalid owner id");
  return path.join(fs.realpathSync(os.tmpdir()), "genex-fresh-machine", ownerId);
}
/** Remove a stopped profile and a fresh-machine home; links inside are removed, never followed. */
export function removeProfile(owner) {
  if (owner.freshMachine === true) fs.rmSync(freshMachineHome(owner.ownerId), { recursive: true, force: true });
  if (owner.gamesOutside === true)
    fs.rmSync(path.dirname(outsideGamesRoot(owner.ownerId)), { recursive: true, force: true });
  fs.rmSync(owner.root, { recursive: true });
}
/** Live profiles hold real sign-ins and are kept; fixture and fresh-machine profiles are thrown away. */
function retentionOf(providers, freshMachine) {
  return providers === "live" && !freshMachine ? "retained" : "disposable";
}
/**
 * Clear the owner record a profile folder deleted by hand left behind: it names this checkout,
 * this id and this folder, and nothing it guarded remains (the lease lived in the folder). Any
 * other record is refused before anything is made.
 */
function clearOrphanRecord(checkout, id, dir) {
  const file = safeChild(devRoot(checkout), `owners/${id}.json`);
  if (!fs.existsSync(file)) return;
  const record = readVersion(file);
  const orphan = record.profileId === id && record.root === dir && record.checkout === fs.realpathSync(checkout);
  if (!orphan) throw new Error(`owners/${id}.json does not belong to this profile; inspect it, or pick another id`);
  fs.unlinkSync(file);
}
export function allocateProfile(checkout, id, providers, fixture, reuse = false, freshMachine = false) {
  if (!["fixture", "live"].includes(providers)) throw new Error("providers must be fixture or live");
  if (freshMachine && providers !== "live") throw new Error("a fresh-machine profile needs --providers live");
  const root = devRoot(checkout),
    dir = profilePath(checkout, id);
  if (fs.existsSync(dir)) {
    if (!reuse) throw new Error("profile already exists; inspect status and explicitly --reuse");
    const owner = validateProfile(checkout, id);
    const sameMode = owner.providers === providers && owner.fixture === fixture;
    if (!sameMode || (owner.freshMachine === true) !== freshMachine)
      throw new Error("reuse cannot change provider mode, fixture or fresh machine");
    return owner;
  }
  clearOrphanRecord(checkout, id, dir);
  fs.mkdirSync(dir, { mode: 0o700 });
  const owner = {
    version: 1,
    ownerId: randomUUID(),
    checkout: fs.realpathSync(checkout),
    profileId: id,
    root: dir,
    createdAt: new Date().toISOString(),
    providers,
    fixture,
    ...(freshMachine ? { freshMachine: true } : {}),
    retention: retentionOf(providers, freshMachine),
  };
  for (const [k, rel] of Object.entries(ownedRoots(owner))) {
    fs.mkdirSync(safeChild(dir, rel), { mode: 0o700 });
    owner[k] = path.join(dir, rel);
  }
  if (gamesGoOutside(providers, freshMachine, dir)) {
    owner.gamesOutside = true;
    owner.games = outsideGamesRoot(owner.ownerId);
    fs.mkdirSync(owner.games, { recursive: true, mode: 0o700 });
  } else {
    fs.mkdirSync(safeChild(dir, "games"), { mode: 0o700 });
    owner.games = path.join(dir, "games");
  }
  if (freshMachine) {
    owner.home = freshMachineHome(owner.ownerId);
    fs.mkdirSync(owner.home, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(safeChild(root, `owners/${id}.json`), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  writeJson(path.join(dir, "owner.json"), owner);
  return owner;
}
export function pidExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
export function assertStopped(owner) {
  const lease = safeChild(owner.root, "lease.json");
  const attemptFile = safeChild(owner.root, "attempt.json");
  if (!fs.existsSync(lease) && fs.existsSync(attemptFile)) {
    const attempt = readVersion(attemptFile);
    if (attempt.pid && pidExists(attempt.pid))
      throw new Error("partial startup may still be running; ownership is uncertain");
  }
  if (fs.existsSync(lease)) {
    const l = readVersion(lease);
    if (l.ownerId !== owner.ownerId || pidExists(l.pid))
      throw new Error("profile is running or ownership is uncertain; use authenticated status/stop");
    fs.unlinkSync(lease);
  }
}
