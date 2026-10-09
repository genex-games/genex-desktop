/**
 * Scaffold a plugin package from the bundled SDK example.
 *
 *     npm run plugin:new -- <id> [--out <parent-directory>]
 *
 * The example is the only template on purpose: it is the package the conformance suite and the
 * packaged smoke already exercise, so a scaffold starts from code that is known to load. Nothing
 * is installed and nothing is fetched — this writes files and prints the next two commands.
 */
import path from "node:path";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPackage, RESERVED_TOOLBAR_LABELS } from "../src/substrate/plugins/manifest.ts";
import { PLUGIN_ID } from "../src/shared/plugin-id.ts";
import { inlinePanelSdk } from "../src/plugin-sdk/inline-panel-sdk.mjs";
import { PLUGIN_GUIDE_URL } from "../src/shared/plugins.ts";
import { SCAFFOLD_PUBLISHER } from "../src/substrate/plugins/pack.ts";
import { scaffoldAgentsGuide } from "./plugin-new-prompts.ts";

/** Studio's own package names; a scaffold may not shadow them. */
const RESERVED = new Set(["genex", "blender", "example", "studio"]);
/** Text files the substitution runs over; anything else is copied byte for byte. */
const TEXT = new Set([".json", ".mjs", ".js", ".cjs", ".ts", ".html", ".css", ".md"]);

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const flag = argv.indexOf("--out");
if (flag !== -1 && !argv[flag + 1]) fail("--out needs a directory");
const out = flag === -1 ? process.cwd() : path.resolve(argv[flag + 1]!);
const outValueAt = flag === -1 ? -1 : flag + 1;
const positional = argv.filter((value, i) => !value.startsWith("--") && i !== outValueAt);
const id = positional[0];

if (!id) fail("Usage: npm run plugin:new -- <id> [--out <parent-directory>]");
if (!PLUGIN_ID.test(id))
  fail(
    `Invalid plugin id "${id}": lowercase letters, digits and dashes, starting with a letter, at most 48 characters`,
  );
if (RESERVED.has(id)) fail(`"${id}" is reserved by Studio; choose another id`);

const destination = path.join(out, id);
if (
  await stat(destination).then(
    () => true,
    () => false,
  )
)
  fail(`${destination} already exists; choose another id or another --out directory`);

/** "my-plugin" → "My plugin": a display name a person can read, editable afterwards. */
const name = id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
const template = path.join(root, "src/plugins/example");

await mkdir(destination, { recursive: true });
await cp(template, destination, { recursive: true });

const walk = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(file)));
    else found.push(file);
  }
  return found;
};

for (const file of await walk(destination)) {
  if (!TEXT.has(path.extname(file).toLowerCase())) continue;
  const text = await readFile(file, "utf8");
  // `example__` is how the example's skill names its own tools to the agent; a scaffold that keeps
  // it would teach every model the wrong tool names.
  // `Example plugin` is the example's toolbar aria-label; two scaffolds keeping it would be an
  // ambiguous selector for the dev-control layer, which refuses those.
  const rewritten = text
    .replaceAll("example__", `${id}__`)
    .replaceAll("Plugin SDK example", name)
    .replaceAll("Example plugin", name);
  if (rewritten !== text) await writeFile(file, rewritten);
}

const manifestFile = path.join(destination, "plugin.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
manifest.id = id;
manifest.name = name;
manifest.version = "0.1.0";
manifest.publisher = SCAFFOLD_PUBLISHER;
manifest.description = `${name}: a Studio plugin scaffolded from the SDK example. Replace this description before publishing.`;
// The button's own text, where it fits and is not one of Studio's reserved stage-strip labels;
// otherwise the example's label stays and the author renames it with the rest of the manifest.
const label = name.slice(0, 24);
if (label.length <= 24 && !RESERVED_TOOLBAR_LABELS.has(label)) {
  for (const item of (manifest.toolbar as Array<{ label: string }> | undefined) ?? [])
    if (item.label === "Example") item.label = label;
}
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

// The panel gets the current bridge inline, where the example marks it: the frame's CSP forbids
// <script src>, and a hand-kept copy drifts from the index.d.ts the author type-checks against.
for (const panel of (manifest.panels as Array<{ file: string }> | undefined) ?? []) {
  const file = path.join(destination, panel.file);
  await writeFile(file, await inlinePanelSdk(await readFile(file, "utf8"), path.join(root, "src/plugin-sdk")));
}

// Keep the authoring contract beside the plugin: an editor or coding agent should
// not need access to Studio's source tree to understand available host services.
await mkdir(path.join(destination, "plugin-sdk"));
await cp(path.join(root, "src/plugin-sdk/index.d.ts"), path.join(destination, "plugin-sdk/index.d.ts"));
const backendFile = path.join(destination, "backend.mjs");
const backend = await readFile(backendFile, "utf8");
await writeFile(
  backendFile,
  backend.replace(
    "export async function activate()",
    "/** @type {import('./plugin-sdk/index.d.ts').Activate} */\nexport const activate = async () =>",
  ),
);
await writeFile(
  path.join(destination, "jsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["backend.mjs", "plugin-sdk/index.d.ts"],
    },
    null,
    2,
  ) + "\n",
);

// The author's coding agent reads this first; packing leaves it out like the editor files.
await writeFile(path.join(destination, "AGENTS.md"), scaffoldAgentsGuide(id, name));

// Fail loudly here rather than at install time: a scaffold that cannot be inspected is a bug in
// this script, not in the author's first edit.
await inspectPackage(destination);

process.stdout.write(
  [
    `Scaffolded ${name} → ${destination}`,
    "",
    "Next:",
    `  npm run plugin:doctor -- ${destination}`,
    "  Genex → Plugins → Add → Load local plugin… → choose that folder (the trust dialog names the publisher and capabilities)",
    "  The plugin's page → More (…) → Watch folder, to reload the backend on every save while you edit",
    "",
    'Then set "publisher" and edit plugin.json (tools, actions, panels, toolbar), backend.mjs and panel.html.',
    "AGENTS.md, plugin-sdk/index.d.ts and jsconfig.json are for you and your coding agent; packing leaves them out.",
    `Guide: ${PLUGIN_GUIDE_URL}`,
    "",
  ].join("\n"),
);
