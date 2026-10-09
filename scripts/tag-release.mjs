import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseTag } from "./release-policy.mjs";

/** `owner/name`, as GITHUB_REPOSITORY spells it. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A full commit id, as GITHUB_SHA spells it. */
const COMMIT = /^[0-9a-f]{40}$/;
/** The workflow that builds, signs and drafts a tagged release. */
const RELEASE_WORKFLOW = "release.yml";

const runGh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Tag `source` as `v<version>` and start that tag's release, unless the tag already exists: a tag
 * is never moved, because a published release's tag is what installed copies update from. A tag
 * the workflow token creates starts no workflow, so the release is dispatched on it.
 */
export async function tagRelease({ version, repo, source, run = runGh }) {
  const tag = releaseTag(version);
  if (!REPOSITORY.test(repo ?? "") || repo.includes("..")) throw new Error("Invalid release repository");
  if (!COMMIT.test(source ?? "")) throw new Error("Invalid release source");
  // A failed lookup throws: an API error is not evidence that the tag is absent.
  const refs = JSON.parse(run(["api", `repos/${repo}/git/matching-refs/tags/${tag}`]));
  if (refs.some((ref) => ref.ref === `refs/tags/${tag}`)) return { tag, created: false };
  const object = JSON.parse(
    run([
      "api",
      `repos/${repo}/git/tags`,
      "-f",
      `tag=${tag}`,
      "-f",
      `message=Genex ${version}`,
      "-f",
      `object=${source}`,
      "-f",
      "type=commit",
    ]),
  );
  run(["api", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${object.sha}`]);
  run(["workflow", "run", RELEASE_WORKFLOW, "--repo", repo, "--ref", tag]);
  return { tag, created: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = await tagRelease({ version, repo: process.env.GITHUB_REPOSITORY, source: process.env.GITHUB_SHA });
  console.log(result.created ? `Tagged ${result.tag} and started its release` : `${result.tag} exists; nothing to do`);
}
