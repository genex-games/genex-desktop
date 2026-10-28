import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { makeTestTmp, sweepTestTmp, testTmpParents } from "./test-tmp.mjs";

/** Local and affected fast groups use two file workers to leave room for their child processes. */
export const FAST_TEST_CONCURRENCY = 2;

// Git exports these to hooks to pin one repository and index. A test that creates a fixture repo
// must not commit into, or overwrite the index of, the developer's checkout.
const GIT_REPO_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** Test children inherit neither Git repository pinning nor a parent test runner's context. */
export function testEnv(env = process.env) {
  // NODE_TEST_CONTEXT would turn a nested run into a silent subtest that exits successfully.
  const drop = new Set(["NODE_TEST_CONTEXT", ...GIT_REPO_ENV]);
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !drop.has(key) && !key.startsWith("GIT_CONFIG_KEY_") && !key.startsWith("GIT_CONFIG_VALUE_"),
    ),
  );
}

/** Fail a test file that leaves children running after its own cleanup instead of hanging the suite. */
export const TEST_PRELOAD = ["--import", new URL("../tests/helpers/leftover-children.ts", import.meta.url).href];

/**
 * Points every temp-folder variable at a folder the batch owns, so what its tests leave in the
 * temp folder goes when the batch ends instead of filling the disk until the OS purges it.
 */
function batchTmpEnv(env, dir) {
  return { ...env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

/** Run one explicit batch, preserving cleanup, environment isolation and failing exit or signal status. */
export function runTestBatch(root, files, { flags = [], concurrency = 1, env = process.env, stdio = "inherit" } = {}) {
  if (!files.length) return 0;
  const args = [...TEST_PRELOAD, "--test", `--test-concurrency=${concurrency}`, ...flags, ...files];
  // A batch killed before its own cleanup left its folder: the next batch removes it.
  sweepTestTmp(testTmpParents());
  const tmp = makeTestTmp();
  try {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio, env: batchTmpEnv(testEnv(env), tmp) });
    if (result.error) console.error(result.error.message);
    if (result.signal) console.error(`Node tests terminated by ${result.signal}`);
    return result.status ?? 1;
  } finally {
    removeBatchTmp(tmp);
  }
}

/** Removes a batch's temp folder; one a test left unremovable is named, never fatal to the run. */
function removeBatchTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`Could not remove the test temp folder ${dir}: ${error.message}`);
  }
}
