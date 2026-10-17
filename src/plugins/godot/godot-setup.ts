/**
 * Godot's setup card in a game's chat while this Mac has no Godot Genex builds with, and Genex
 * installing it for the person: the newest stable Godot 4 from Godot's own releases, its zip
 * unpacked into the plugin's storage, and `Godot.app` copied into Applications only once
 * `codesign` accepts it as Godot's team's Developer ID and Gatekeeper does (an older `Godot.app`
 * there goes to the Trash). One step, with Do it for me; Don't use Godot (or Stop while it works,
 * which ends the download, the unpacking or the copy) in Hide's place; the agent is told once Godot
 * is found. The download is removed whether the install ends well or not.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import type { PluginSetupButton, PluginSetupCard, PluginSetupStep } from "../../plugin-sdk/index.d.ts";
import {
  APP_COPY_MS,
  AppInstallError,
  AppInstallProblem,
  type AppRunner,
  downloadFile,
  placeApp,
} from "../../substrate/app-install.ts";
import type { GodotInstall } from "./find-godot.ts";

/** The card's actions, by the names the manifest declares. Wire values: never rename one. */
export const GodotSetupAction = {
  Steps: "steps",
  Install: "install-godot",
  Stop: "stop-install",
  Skip: "skip",
} as const;
export type GodotSetupAction = (typeof GodotSetupAction)[keyof typeof GodotSetupAction];

/** The card's one row. Wire value. */
const STEP_ID = "get-godot";
/** Godot's own releases, where the newest stable one is read. */
export const GODOT_RELEASES = "https://api.github.com/repos/godotengine/godot/releases/latest";
/** Godot's team at Apple: the only signer whose Godot Genex installs. */
export const GODOT_TEAM_ID = "6K46PWY5DM";
/** The app inside Godot's zip, and its name in Applications. */
const GODOT_APP = "Godot.app";
/** The release asset Genex installs: the standard (not .NET) universal Mac build of a stable Godot 4. */
const MAC_ASSET = /^Godot_v(4\.\d+(?:\.\d+)?)-stable_macos\.universal\.zip$/;
/** The plugin storage folder holding the download while it unpacks. */
const SETUP_FOLDER = "godot-setup";

const MEGABYTE = 1024 * 1024;

const WORDS = {
  Title: "Godot setup",
  Intro: "One step before the agent can build in Godot.",
  Working: "Genex is installing Godot. Nothing is needed from you.",
  Get: "Get Godot 4",
  GetDetail: "Free and open source, about 170 MB. Genex installs it in Applications.",
  Downloading: (version: string) => `Downloading Godot ${version}`,
  Installing: (version: string) => `Installing Godot ${version}`,
  Bytes: (done: number, total: number) => `${Math.round(done / MEGABYTE)} of ${Math.round(total / MEGABYTE)} MB`,
  Starting: "Starting…",
  Ready: (version: string) => `Godot ${version} is installed`,
  DoItForMe: "Do it for me",
  TryAgain: "Try again",
  Stop: "Stop",
  Skip: "Don't use Godot",
  Done: (version: string) =>
    `Godot ${version} is installed on this Mac. Go on with the person's game in Godot: call godot__new-game if it has no Godot project yet.`,
  Skipped:
    "The person chose not to use Godot for now (Don't use Godot on the setup card). Offer in one line to build the game as a web game that plays in Genex instead, and do it if they agree.",
  Stuck: (why: string) =>
    `Genex's install of Godot for the person stopped: ${why} Tell them in one line what stopped and that Try again is on the card, or that they can download Godot from godotengine.org and put it in Applications.`,
  NoRelease: "Godot's releases list no Mac build of Godot 4 right now.",
  Download: (why: string) => `Couldn't download Godot (${why}). Check your connection, then try again.`,
  NotGodot: "This Godot isn't signed by the Godot team, so Genex didn't install it.",
  Copy: (why: string) => `Couldn't put Godot in Applications (${why}).`,
  YouStopped: "You stopped it. Try again when you want Godot.",
} as const;

/** Where Genex's install of Godot stands. Wire values. */
export const GodotJobState = { Running: "running", Failed: "failed" } as const;
export type GodotJobState = (typeof GodotJobState)[keyof typeof GodotJobState];

/** The install under way, or the last one that stopped. */
export interface GodotJob {
  state: GodotJobState;
  version?: string;
  done?: number;
  total?: number;
  unpacking?: boolean;
  why?: string;
  stopped?: true;
}

type Button = PluginSetupButton & { name: GodotSetupAction };
const button = (name: GodotSetupAction, label: string): Button => ({ name, args: {}, label });

/** The row: installed, being installed (how far), stopped, or to get. */
function row(install: GodotInstall | undefined, job: GodotJob | null): PluginSetupStep {
  const versionOf = (i: GodotInstall) => `${i.version.major}.${i.version.minor}`;
  if (install) return { id: STEP_ID, label: WORDS.Ready(versionOf(install)), detail: "", done: true };
  const version = job?.version ?? "4";
  if (job?.state === GodotJobState.Running && job.unpacking)
    return { id: STEP_ID, label: WORDS.Installing(version), detail: "", done: false, working: true };
  if (job?.state === GodotJobState.Running) {
    const detail = job.total ? WORDS.Bytes(job.done ?? 0, job.total) : WORDS.Starting;
    return { id: STEP_ID, label: WORDS.Downloading(version), detail, done: false, working: true };
  }
  if (job?.state === GodotJobState.Failed)
    return { id: STEP_ID, label: WORDS.Get, detail: job.why ?? "", done: false, you: true };
  return { id: STEP_ID, label: WORDS.Get, detail: WORDS.GetDetail, done: false };
}

/** Godot's setup card for this Mac now, the install under way, and whether the person chose Don't use Godot here. */
export function godotSetupCard(
  install: GodotInstall | undefined,
  job: GodotJob | null,
  skipped: boolean,
): PluginSetupCard {
  const steps = [row(install, job)];
  const done = install ? `${install.version.major}.${install.version.minor}` : null;
  const base = { title: WORDS.Title, steps };
  if (done) return { ...base, intro: WORDS.Intro, open: false, doneSays: WORDS.Done(done) };
  if (skipped) return { ...base, intro: WORDS.Intro, open: false, doneSays: WORDS.Skipped };
  const running = job?.state === GodotJobState.Running;
  const failed = job?.state === GodotJobState.Failed;
  return {
    ...base,
    intro: running ? WORDS.Working : WORDS.Intro,
    open: true,
    ...(running ? {} : { primary: button(GodotSetupAction.Install, failed ? WORDS.TryAgain : WORDS.DoItForMe) }),
    secondary: running ? button(GodotSetupAction.Stop, WORDS.Stop) : button(GodotSetupAction.Skip, WORDS.Skip),
    ...(failed && !job?.stopped ? { stuckSays: WORDS.Stuck(job?.why ?? "") } : {}),
  };
}

/** The newest stable Godot 4 Mac build in Godot's release answer: its version and download. */
export function godotAsset(release: unknown): { version: string; url: string } | undefined {
  const assets = (release as { assets?: unknown })?.assets;
  if (!Array.isArray(assets)) return undefined;
  for (const asset of assets) {
    const name = (asset as { name?: unknown })?.name;
    const url = (asset as { browser_download_url?: unknown })?.browser_download_url;
    const match = typeof name === "string" ? MAC_ASSET.exec(name) : null;
    if (match?.[1] && typeof url === "string" && url.startsWith("https://github.com/godotengine/godot/"))
      return { version: match[1], url };
  }
  return undefined;
}

/** What installing Godot reaches: the network, programs, Applications, the person's Trash and the plugin's storage. */
export interface GodotInstallDeps {
  fetch: typeof fetch;
  run: AppRunner;
  applications: string;
  /** Where an older `Godot.app` in Applications goes (`~/.Trash`). */
  trash: string;
}

/** The installer: one install at a time, kept in memory; Stop ends it. */
export function createGodotInstaller(deps: GodotInstallDeps, storage: () => Promise<string>) {
  let job: GodotJob | null = null;
  let stop = new AbortController();
  let running: Promise<void> | null = null;

  const fail = (why: string) => {
    job = stop.signal.aborted
      ? { state: GodotJobState.Failed, why: WORDS.YouStopped, stopped: true }
      : { state: GodotJobState.Failed, why };
  };

  /** Downloads the asset into `folder` with progress, unpacks it and copies the checked app into Applications; a Stop ends it between steps. */
  async function fetchAndPlace(asset: { url: string }, current: GodotJob, folder: string, signal: AbortSignal) {
    const zip = path.join(folder, "godot.zip");
    await downloadFile(deps.fetch, asset.url, zip, {
      signal,
      onBytes: (done, total) => {
        current.done = done;
        if (total) current.total = total;
      },
    }).catch((error: unknown) => {
      throw new Error(WORDS.Download(errorMessage(error)));
    });
    current.unpacking = true;
    const unpacked = path.join(folder, "unpacked");
    await deps.run("/usr/bin/ditto", ["-x", "-k", zip, unpacked], APP_COPY_MS, signal);
    signal.throwIfAborted();
    const place = { applications: deps.applications, name: GODOT_APP, team: GODOT_TEAM_ID, trash: deps.trash };
    await placeApp(deps.run, path.join(unpacked, GODOT_APP), place, signal).catch((error: unknown) => {
      const notSigned = error instanceof AppInstallError && error.problem === AppInstallProblem.NotSigned;
      throw new Error(notSigned ? WORDS.NotGodot : WORDS.Copy(errorMessage(error)));
    });
  }

  /** Finds the release, then downloads, unpacks and places it; its download is gone afterwards either way. */
  async function install(signal: AbortSignal): Promise<void> {
    job = { state: GodotJobState.Running };
    const release = await deps.fetch(GODOT_RELEASES, { signal }).then((r) => r.json());
    const asset = godotAsset(release);
    if (!asset) throw new Error(WORDS.NoRelease);
    const current: GodotJob = { state: GodotJobState.Running, version: asset.version };
    job = current;
    const folder = path.join(await storage(), SETUP_FOLDER);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    try {
      await fetchAndPlace(asset, current, folder, signal);
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
    job = null;
  }

  return {
    job: (): GodotJob | null => job,
    /** Do it for me (and Try again): starts the install and answers at once; the card follows it. */
    install: (): void => {
      if (running) return;
      stop = new AbortController();
      running = install(stop.signal)
        .catch((error: unknown) => fail(errorMessage(error)))
        .finally(() => {
          running = null;
        });
    },
    /** Stop: ends the download or the copy and keeps it as stopped, for Try again. */
    stop: async (): Promise<void> => {
      stop.abort();
      await running;
      if (job?.state === GodotJobState.Running)
        job = { state: GodotJobState.Failed, why: WORDS.YouStopped, stopped: true };
    },
    /** The install while it runs, for tests that wait it out. */
    running: (): Promise<void> | null => running,
  };
}

export type GodotInstaller = ReturnType<typeof createGodotInstaller>;
