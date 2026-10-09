/**
 * `src/plugin-sdk/index.d.ts` is the contract plugin authors compile against, and the project's
 * own `tsconfig` has `skipLibCheck: true` — so `npm run typecheck` never looks inside it. This
 * suite is the only guard: it compiles real sources against the declaration file with lib checking
 * ON, proves the manifest mirror is still structurally identical to `src/shared/plugins.ts` in
 * both directions, and proves an undeclared host method is a compile error rather than a runtime
 * surprise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";

const sdk = path.resolve("src/plugin-sdk/index.d.ts");
const shared = path.resolve("src/shared/plugins.ts");
const quote = (file: string) => JSON.stringify(file);

function compile(t: { after: (fn: () => void) => void }, files: Record<string, string>): ts.Diagnostic[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sdk-types-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = Object.entries(files).map(([name, text]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  });
  const program = ts.createProgram([...names, sdk], {
    strict: true,
    noEmit: true,
    // Deliberately not skipped: the declaration file itself is what is under test.
    skipLibCheck: false,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
  });
  const own = new Set([...names, sdk]);
  // The compiler spells file names with forward slashes, on Windows too.
  return ts.getPreEmitDiagnostics(program).filter((d) => d.file && own.has(path.resolve(d.file.fileName)));
}

const report = (diagnostics: ts.Diagnostic[]) =>
  diagnostics
    .map(
      (d) =>
        `${path.basename(d.file?.fileName ?? "?")}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    )
    .join("\n");

test("a backend written against the SDK declaration compiles clean", (t) => {
  const diagnostics = compile(t, {
    "backend.ts": `
      import type { Activate, PluginToolbarStatus } from ${quote(sdk)};
      let calls = 0;
      export const activate: Activate = async () => ({
        async tool(name, args, ctx) {
          calls++;
          if (ctx.signal.aborted) throw new Error('stopped');
          if (name === 'shout') return { text: String(args.text).toUpperCase(), project: ctx.project };
          const settings = await ctx.host('settings.read');
          return { text: \`\${String(settings.greeting)} \${String(args.name)}\`, callId: ctx.callId };
        },
        async action(name): Promise<PluginToolbarStatus | { text: string }> {
          if (name === 'count') return { badge: String(calls), tone: 'ok' };
          return { text: 'ready' };
        },
        async review() { return { message: 'Proceed?', images: [{ label: 'preview', dataUrl: 'data:image/png;base64,AA' }] }; },
      });
    `,
    "services.ts": `
      import type { PluginContext } from ${quote(sdk)};
      export async function everyService(ctx: PluginContext) {
        const root: string = await ctx.host('storage.root');
        const text: string = await ctx.host('project.read', { path: 'index.html' });
        const written: { file: string } = await ctx.host('project.write', { path: 'a.txt', text: 'x' });
        const delivered: string[] = await ctx.host('assets.deliver', { output: root, jobId: 'job-1' });
        const exported = await ctx.host('export.stage');
        const token: string | null = await ctx.host('credentials.read');
        await ctx.host('credentials.write', { token: 'secret' });
        await ctx.host('credentials.clear');
        await ctx.host('jobs.write', { id: 'job-1', value: { ok: true } });
        const job: unknown = await ctx.host('jobs.read', { id: 'job-1' });
        await ctx.host('events.emit', { kind: 'toolbar', item: 'publish', badge: 'Draft', tone: 'info' });
        await ctx.host('observe', { project: 'g', root: '/games/g', files: ['index.html'] });
        const snapshot: { snapshotId: string } = await ctx.host('game.snapshot', { reason: 'Before an update' });
        return { root, text, written, delivered, dir: exported.dir, files: exported.files, token, job, snapshot };
      }
    `,
    "panel.ts": `
      import type { PluginPanelContext } from ${quote(sdk)};
      export async function boot(): Promise<string | null> {
        const context: PluginPanelContext = await window.studioPlugin.call('context');
        await window.studioPlugin.call('settings');
        await window.studioPlugin.call('action', 'hello', {});
        const chosen: string | null = await window.studioPlugin.chooseFile({ title: 'Choose a project', extensions: ['uproject'] });
        window.studioPlugin.ui?.status('Status', 'ready');
        return chosen ?? context.project;
      }
    `,
  });
  assert.equal(diagnostics.length, 0, report(diagnostics));
});

test("the SDK manifest mirror, its skills and tool hosts, and src/shared/plugins.ts are mutually assignable", (t) => {
  const diagnostics = compile(t, {
    "parity.ts": `
      import type { PluginManifest as SdkManifest, PluginTool as SdkTool, PluginToolbarItem as SdkItem, PluginToolbarStatus as SdkStatus } from ${quote(sdk)};
      import type { PluginManifest as SharedManifest, PluginTool as SharedTool, PluginToolbarItem as SharedItem, PluginToolbarStatus as SharedStatus } from ${quote(shared)};
      declare const sdkManifest: SdkManifest;
      declare const sharedManifest: SharedManifest;
      export const toShared: SharedManifest = sdkManifest;
      export const toSdk: SdkManifest = sharedManifest;
      declare const sdkTool: SdkTool; declare const sharedTool: SharedTool;
      export const toolToShared: SharedTool = sdkTool;
      export const toolToSdk: SdkTool = sharedTool;
      declare const sdkItem: SdkItem; declare const sharedItem: SharedItem;
      export const itemToShared: SharedItem = sdkItem;
      export const itemToSdk: SdkItem = sharedItem;
      declare const sdkStatus: SdkStatus; declare const sharedStatus: SharedStatus;
      export const statusToShared: SharedStatus = sdkStatus;
      export const statusToSdk: SdkStatus = sharedStatus;
    `,
    "skills.ts": `
      import type { PluginSkill as SdkSkill, PluginFileSkill as SdkFileSkill, PluginManifestTool as SdkManifestTool, PluginHostTool as SdkHost } from ${quote(sdk)};
      import type { PluginSkill as SharedSkill, PluginFileSkill as SharedFileSkill, PluginManifestTool as SharedManifestTool, PluginHostTool as SharedHost } from ${quote(shared)};
      declare const sdkSkill: SdkSkill; declare const sharedSkill: SharedSkill;
      export const skillToShared: SharedSkill = sdkSkill;
      export const skillToSdk: SdkSkill = sharedSkill;
      declare const sdkFile: SdkFileSkill; declare const sharedFile: SharedFileSkill;
      export const fileToShared: SharedFileSkill = sdkFile;
      export const fileToSdk: SdkFileSkill = sharedFile;
      declare const sdkManifestTool: SdkManifestTool; declare const sharedManifestTool: SharedManifestTool;
      export const manifestToolToShared: SharedManifestTool = sdkManifestTool;
      export const manifestToolToSdk: SdkManifestTool = sharedManifestTool;
      declare const sdkHost: SdkHost; declare const sharedHost: SharedHost;
      export const hostToShared: SharedHost = sdkHost;
      export const hostToSdk: SdkHost = sharedHost;
    `,
  });
  assert.equal(diagnostics.length, 0, report(diagnostics));
});

test("the panel's Choose file request and src/shared/plugin-file-request.ts are mutually assignable", (t) => {
  const request = path.resolve("src/shared/plugin-file-request.ts");
  const diagnostics = compile(t, {
    "file-request.ts": `
      import type { PluginFileRequest as SdkRequest } from ${quote(sdk)};
      import type { PluginFileRequest as SharedRequest } from ${quote(request)};
      declare const sdkRequest: SdkRequest; declare const sharedRequest: SharedRequest;
      export const requestToShared: SharedRequest = sdkRequest;
      export const requestToSdk: SdkRequest = sharedRequest;
    `,
  });
  assert.equal(diagnostics.length, 0, report(diagnostics));
});

test("the SDK's moments, what a handler is told and what it answers, and src/shared/plugin-hooks.ts are mutually assignable", (t) => {
  const hooks = path.resolve("src/shared/plugin-hooks.ts");
  const diagnostics = compile(t, {
    "hooks.ts": `
      import type { PluginHookAnswer as SdkAnswer, PluginHookContext as SdkContext, PluginHookEvent as SdkEvent } from ${quote(sdk)};
      import type { HookAnswer as SharedAnswer, HookContext as SharedContext, HookEvent as SharedEvent } from ${quote(hooks)};
      declare const sdkEvent: SdkEvent; declare const sharedEvent: SharedEvent;
      export const eventToShared: SharedEvent = sdkEvent;
      export const eventToSdk: SdkEvent = sharedEvent;
      declare const sdkContext: SdkContext; declare const sharedContext: SharedContext;
      export const contextToShared: SharedContext = sdkContext;
      export const contextToSdk: SdkContext = sharedContext;
      declare const sdkAnswer: SdkAnswer; declare const sharedAnswer: SharedAnswer;
      export const answerToShared: SharedAnswer = sdkAnswer;
      export const answerToSdk: SdkAnswer = sharedAnswer;
    `,
  });
  assert.equal(diagnostics.length, 0, report(diagnostics));
});

test("an undeclared host method and a non-scalar tool argument are compile errors", (t) => {
  const wrongHost = compile(t, {
    "steal.ts": `
      import type { PluginContext } from ${quote(sdk)};
      export const run = (ctx: PluginContext) => ctx.host('credentials.steal');
    `,
  });
  assert.ok(
    wrongHost.some((d) => d.file?.fileName.endsWith("steal.ts")),
    "an unknown host method must not type-check",
  );

  const wrongArgs = compile(t, {
    "nested.ts": `
      import type { Activate } from ${quote(sdk)};
      export const activate: Activate = async () => ({
        async tool(_name, args) { const nested: { deep: string } = args.payload; return nested; },
      });
    `,
  });
  assert.ok(
    wrongArgs.some((d) => d.file?.fileName.endsWith("nested.ts")),
    "tool arguments must stay scalar",
  );
});
