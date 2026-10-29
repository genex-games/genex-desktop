/**
 * An update of the app itself, as main tells the window about it. On macOS and Windows it is
 * downloaded in the background (`main/auto-update.ts`) and installed by a restart the person
 * chooses, or at the next quit; on Linux, where nothing installs it in place, it is a newer
 * release the person downloads (`main/release-check.ts`).
 */

/** What the person does with a waiting update. */
export const UpdateAction = {
  /** Downloaded: relaunch to install it. */
  Restart: "restart",
  /** Published but not installable in place: open its release page to download it. */
  Download: "download",
} as const;
export type UpdateAction = (typeof UpdateAction)[keyof typeof UpdateAction];

/** What is running, for Settings → About: the version (null in an unpackaged build), platform and architecture. */
export interface AppAbout {
  version: string | null;
  platform: string;
  arch: string;
}

/** A new version waiting for the person: downloaded for a restart, or published for a download. */
export interface ReadyUpdate {
  /** The release's version ("0.2.0"), or null when the release named none. */
  version: string | null;
  action: UpdateAction;
}

/** What a Check for Updates found. */
export const UpdateCheckStatus = {
  /** This is the newest published version. */
  Current: "current",
  /** A newer version was found and is downloading; it announces itself when ready. */
  Downloading: "downloading",
  /** A newer version waits (`ReadyUpdate`): relaunch or download. */
  Waiting: "waiting",
  /** Linux from the Genex package repository: the system's own updates bring new versions. */
  System: "system",
  /** This build never checks: a development, test or self-packaged launch. */
  Off: "off",
  /** The check did not finish: offline, the service failed, or it took too long. */
  Failed: "failed",
} as const;
export type UpdateCheckStatus = (typeof UpdateCheckStatus)[keyof typeof UpdateCheckStatus];

/** The answer to a Check for Updates. */
export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  /** The running version ("0.1.0"). */
  current: string;
  /** The waiting update, when `status` is waiting. */
  update: ReadyUpdate | null;
}
