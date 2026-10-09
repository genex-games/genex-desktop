# Windows sandbox broker

Apache-2.0-licensed SRT broker source from Anthropic sandbox-runtime v0.0.73,
commit `5feb5269f1c86f49e62224ffb8297b2f01a31806`:
https://github.com/anthropics/sandbox-runtime/tree/5feb5269f1c86f49e62224ffb8297b2f01a31806/vendor/srt-win-src

`src/acl.rs` backports the parent-only ACL correction from lie5860's PR #523,
commit `26dbcbeaa29e665af25b6685564b3d550d94cf2c`:
https://github.com/anthropics/sandbox-runtime/pull/523
`tests/acl_parent_scope.rs` is copied from that same revision. The upstream public
test CA fixture is copied into `tests/fixtures/ca.crt`, and the test-only include in
`src/cert_store.rs` points there. The test in `src/sid.rs` resolves the localized
BUILTIN Users group name through its well-known SID instead of assuming English.
Other upstream sources,
the Cargo manifest and the lockfile retain v0.0.73 contents. The correction keeps the
parent deletion guard and descendant denies, suppressing propagation only when the
changed sandbox entries apply to the parent itself. Legacy inheritable entries still
require propagation during removal. Account, WFP, token, journal and CLI protocols
are unchanged. This is a local backport of an unmerged patch, not an upstream release.

Genex additionally handles a profile directory held without delete sharing:
if the maximum-access open fails, a no-follow read/security handle without delete
sharing pins the pathname while SetFileSecurityW writes an object-only DACL. The
read right is needed for Windows to enforce the sharing mask; no file contents are
read. This preserves inherited entries and DACL protection. On the narrow fallback,
Windows clears the AUTO_INHERITED bookkeeping marker; only this measured marker
normalization is allowed by the locked-parent descriptor regression. Ownership,
protection, inherited ACE flags, other principals, masks and ordering must match;
existing/future siblings retain their permissions. Full grants, full
denies and cleanup of legacy inheritable entries continue
through the propagating writer. Owned-fixture tests cover the sharing violation,
protected and unprotected descriptors, other principals, existing/future siblings
and release. No policy deadline is extended.

On a later unlocked run, a descriptor without AUTO_INHERITED also uses the pinned
object-only writer: SetSecurityInfo would otherwise rematerialize parent ACEs or
change the bookkeeping marker. The DELETE-capable handle is released before
repinning; volume/file identity must match across that reopen gap or the operation
fails closed. The descriptor and siblings must round-trip byte for byte on repeat.

The Electron / React / TypeScript application remains the original stack. Rust and
the Windows MSVC build tools are build prerequisites for this native dependency.
`scripts/build-windows-sandbox.mjs` compiles with `--locked` and a static CRT into the
ignored `.studio-dev/native` cache, then replaces the SDK's broker at its usual path.
It copies these notices and dependency licenses beside the packaged executable.
No binary or compiler output belongs in Git. Native tests:

```powershell
cargo test --release --locked --manifest-path native/srt-win/Cargo.toml
```
