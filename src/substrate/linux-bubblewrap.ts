/**
 * The app's own bubblewrap on Linux, which the sandbox runs instead of the system's when it is there.
 *
 * Ubuntu 24.10 and later confine /usr/bin/bwrap itself (AppArmor's `bwrap-userns-restrict`): its
 * children run under `unpriv_bwrap`, which denies every capability, so the nested user namespace
 * sandbox-runtime's seccomp step makes inside bubblewrap is refused and no agent process starts. A
 * copy anywhere else attaches to no profile of its own and runs under the app's (`genex`, which
 * allows user namespaces), as /usr/bin/bwrap does on 24.04. The deb's postinst copies it beside the
 * packaged executable, root-owned, on every install and upgrade where the system confines
 * bubblewrap; the setup screen's command does the same for any other install (linux-isolation.ts).
 * It is never made in a folder a sandboxed command can write: a replaced copy would run outside.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** The copy's file name, beside the app's executable. */
export const OWN_BUBBLEWRAP = "bwrap";
/** Ubuntu's AppArmor profile that confines /usr/bin/bwrap, under /etc. */
export const BUBBLEWRAP_RESTRICTION = ["apparmor.d", "bwrap-userns-restrict"] as const;

/** Where the app's own bubblewrap goes for the executable at `execPath`. */
export function ownBubblewrapPath(execPath: string): string {
  return path.posix.join(path.posix.dirname(execPath), OWN_BUBBLEWRAP);
}

/** The app's own bubblewrap beside `execPath` when there is one; null runs the system's. */
export function ownBubblewrap(execPath: string = process.execPath): string | null {
  const file = path.join(path.dirname(execPath), OWN_BUBBLEWRAP);
  return existsSync(file) ? file : null;
}

/** Does this system confine /usr/bin/bwrap (Ubuntu 24.10 and later)? */
export function bubblewrapConfined(etcRoot = "/etc"): boolean {
  return existsSync(path.join(etcRoot, ...BUBBLEWRAP_RESTRICTION));
}
