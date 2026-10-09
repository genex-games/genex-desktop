import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDraftTarget,
  assertStableDownloads,
  assertUpdateFeedAssets,
  distributionPlatforms,
} from "./release-policy.mjs";
import { createHash } from "node:crypto";
import { verifyReleaseArtifacts } from "./release-manifest.mjs";

const runGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Validate local artifacts before creating a draft; retries never overwrite existing assets. */
export async function uploadRelease({ version, repo, source, macos, windows, directory = "upload", run = runGh }) {
  if (!repo || !source) throw new Error("Release repository and source are required");
  distributionPlatforms({ macos, windows });
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.length) throw new Error("No release artifacts");
  if (entries.some((entry) => !entry.isFile())) throw new Error("Release artifacts must be regular files");
  const names = entries.map((entry) => entry.name);
  assertUpdateFeedAssets(names, { windows });
  assertStableDownloads(names, { windows });
  const files = entries.map((entry) => path.join(directory, entry.name)).sort();
  const tag = `v${version}`;
  // Resolve annotated and lightweight tags to the commit. Missing tags and API failures both refuse writes.
  const tagged = JSON.parse(run(["api", `repos/${repo}/commits/${encodeURIComponent(tag)}`]));
  if (tagged.sha !== source) throw new Error("Release tag does not identify the candidate source");
  // An API error is not evidence that a release is absent. List successfully before deciding to create.
  const releases = JSON.parse(run(["release", "list", "--repo", repo, "--limit", "1000", "--json", "tagName"]));
  if (releases.some((release) => release.tagName === tag)) {
    const existing = JSON.parse(run(["release", "view", tag, "--repo", repo, "--json", "isDraft,targetCommitish"]));
    assertDraftTarget(existing, source);
  } else {
    const args = [
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--draft",
      "--verify-tag",
      "--target",
      source,
      "--title",
      `Genex ${version}`,
      "--generate-notes",
    ];
    if (version.includes("-")) args.push("--prerelease");
    run(args);
  }
  run(["release", "upload", tag, ...files, "--repo", repo]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, devDependencies } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lockfile = await readFile(new URL("../package-lock.json", import.meta.url));
  const signing = {
    macos: process.env.RELEASE_MACOS_SIGNED === "true",
    windows: process.env.RELEASE_WINDOWS_SIGNED === "true",
  };
  await verifyReleaseArtifacts(
    "upload",
    {
      version,
      source: process.env.GITHUB_SHA,
      electron: devDependencies.electron,
      lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
    },
    distributionPlatforms(signing),
  );
  await uploadRelease({ version, repo: process.env.GITHUB_REPOSITORY, source: process.env.GITHUB_SHA, ...signing });
}
