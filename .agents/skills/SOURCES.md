# Design skill provenance

Upstream: [jakubkrehel/skills](https://github.com/jakubkrehel/skills).
Pinned commit: [267330e1adfc66a718fb65fa6918c1f06d0a689e](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e).
Installed 2026-09-19 with the Codex skill installer's `install-skill-from-github.py`, using
`--repo jakubkrehel/skills --ref 267330e1adfc66a718fb65fa6918c1f06d0a689e --dest .agents/skills`
and the seven `skills/<name>` paths below.

- `better-ui`
- `better-layout`
- `better-colors`
- `better-writing`
- `better-typography`
- `break`
- `variant`

Each directory includes the complete upstream skill and supporting files, with the local
adaptations below. The MIT license is retained in [LICENSE.jakubkrehel](LICENSE.jakubkrehel).

`break/SKILL.md` and `variant/SKILL.md` keep the upstream `disable-model-invocation: true`
frontmatter, which Claude Code honours; Codex reads the equivalent policy,
`allow_implicit_invocation: false`, from their upstream `agents/openai.yaml`. Both stay opt-in.

Mirror: `.claude/skills/` is a byte-identical copy of this directory for Claude Code, so both
agents load the same design and engineering skills. Edit here, copy there;
`tests/conformance/skills-sync.test.ts` fails on any difference. The engineering skills
(`add-ipc-channel`, `add-event-type`, `add-plugin-tool`, `run-area-tests`,
`verify-ui-via-dev-control`, `harness-incident-fix`) and the design skill `wire-art` (Genex's
wireframe art language) are local to this repository.

Local design rule (2026-09-19): `better-ui/SKILL.md` adds "Pointer cursor for clickable controls"
to enforce the application's cursor convention and review enabled, disabled and specialized
interactions. Preserve this addition when updating upstream skills. All other upstream bytes
are unchanged; the other skills retain default automatic discovery.

Repository scope, routing, accessibility baseline and overrides for generic recipes live in
[the design workflow](../../docs/agent/design.md), with foundations in
[AGENTS.md](../../AGENTS.md#design-foundations). Cross-references to other upstream skills
do not imply they are installed.
