// The Linux package repository (packages.genex.games) a deb or rpm adds on install: after a
// publish, the system's own update must offer the new version from it.
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { PackageKind, type WaitClock } from "./links.ts";
import type { Verdict } from "./platforms.ts";
import { StepOutcome } from "./results.ts";
import { asRoot, sh, tail } from "./shell.ts";

/** The repository's host, as apt names it in a source line. */
const REPOSITORY_HOST = "packages.genex.games";
/** The dnf repository id the rpm's %post writes (build/linux/rpm-post). */
const DNF_REPO_ID = "genex";
/** linux-repo.yml fills the repository after the publish; give it this long. */
export const REPOSITORY_WAIT_MS = 30 * MINUTE_MS;
const REPOSITORY_POLL_MS = 60 * SECOND_MS;
/** Failed queries in a row after which the wait stops: a broken query does not mend by waiting. */
const MAX_FAILED_QUERIES = 3;

/** The versions of genex apt's `madison` lists from the Genex repository. */
export function aptVersions(madison: string): string[] {
  return madison
    .split(/\r?\n/)
    .map((line) => line.split("|").map((field) => field.trim()))
    .filter((fields) => fields.length >= 3 && fields[2]?.includes(REPOSITORY_HOST))
    .map((fields) => fields[1] ?? "");
}

/** Whether a package version is the release's version (an rpm's or deb's own revision suffix allowed). */
export function isRelease(packageVersion: string, version: string): boolean {
  return packageVersion === version || packageVersion.startsWith(`${version}-`);
}

/** What the repository offers now, by the system's own tools; the output for the evidence. */
async function offered(kind: PackageKind): Promise<{ ok: boolean; versions: string[]; output: string }> {
  if (kind === PackageKind.Deb) {
    const [command, args] = asRoot(["apt-get", "update", "-q"]);
    const update = await sh(command, args);
    const madison = await sh("apt-cache", ["madison", "genex"]);
    return {
      ok: update.code === 0 && madison.code === 0,
      versions: aptVersions(madison.stdout),
      output: `${tail(update.stdout + update.stderr, 6)}\n${madison.stdout}`,
    };
  }
  // -y: the first query of a gpg-checked repository imports its key, which otherwise asks.
  const query = [
    "dnf",
    "-y",
    "--refresh",
    "repoquery",
    `--repo=${DNF_REPO_ID}`,
    "--queryformat",
    "%{version}\n",
    "genex",
  ];
  const [command, args] = asRoot(query);
  const ran = await sh(command, args);
  return {
    ok: ran.code === 0,
    versions: ran.stdout.split(/\s+/).filter(Boolean),
    output: `${ran.stdout}${ran.stderr}`,
  };
}

/** Wait until the repository the package added offers `version`, within {@link REPOSITORY_WAIT_MS}. */
export async function waitForRepository(kind: PackageKind, version: string, clock: WaitClock): Promise<Verdict> {
  const started = clock.now();
  let failedQueries = 0;
  for (;;) {
    const { ok, versions, output } = await offered(kind);
    const waited = Math.round((clock.now() - started) / SECOND_MS);
    if (versions.some((offer) => isRelease(offer, version)))
      return { outcome: StepOutcome.Pass, detail: `${REPOSITORY_HOST} offers ${version} (after ${waited} s)` };
    failedQueries = ok ? 0 : failedQueries + 1;
    console.log(
      `repository: offers ${versions.join(", ") || "nothing"} after ${waited} s${ok ? "" : ` (query failed: ${tail(output, 3)})`}`,
    );
    const givesUp =
      failedQueries >= MAX_FAILED_QUERIES || clock.now() - started + REPOSITORY_POLL_MS > REPOSITORY_WAIT_MS;
    if (givesUp)
      return {
        outcome: StepOutcome.Fail,
        detail: `${REPOSITORY_HOST} offers ${versions.join(", ") || "nothing"} after ${waited} s, not ${version}: ${tail(output, 8)}`,
      };
    await clock.sleep(REPOSITORY_POLL_MS);
  }
}
