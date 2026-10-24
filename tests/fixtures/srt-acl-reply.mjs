// A real child process for the async ACL transport tests; never edits a filesystem ACL.
const [mode, ...args] = process.argv.slice(2);
if (mode === "bad-json") {
  process.stdout.write("not JSON");
} else {
  const paths = [{ path: JSON.stringify(args), status: "revoked" }];
  const parents = [{ path: "fixture-parent", status: "stillHeld" }];
  process.stdout.write(JSON.stringify(mode === "legacy" ? { paths, parents } : paths));
}
if (mode === "partial") {
  process.stderr.write("synthetic partial cleanup");
  process.exitCode = 2;
}
