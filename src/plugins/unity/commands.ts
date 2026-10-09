/** Editor methods exposed to the agent. One vocabulary owns dispatch, manifests and documentation. */
export const UnityMethod = {
  Status: "editor.status",
  Console: "editor.console",
  Play: "editor.play",
  Stop: "editor.stop",
  Pause: "editor.pause",
  Step: "editor.step",
  Undo: "editor.undo",
  Redo: "editor.redo",
  SceneList: "scene.list",
  SceneCreate: "scene.create",
  SceneOpen: "scene.open",
  SceneSave: "scene.save",
  SceneClose: "scene.close",
  Hierarchy: "hierarchy.list",
  ObjectInspect: "object.inspect",
  ObjectCreate: "object.create",
  ObjectUpdate: "object.update",
  ObjectDelete: "object.delete",
  ComponentList: "component.list",
  ComponentAdd: "component.add",
  ComponentRemove: "component.remove",
  ComponentGet: "component.get",
  ComponentSet: "component.set",
  AssetSearch: "asset.search",
  AssetInspect: "asset.inspect",
  AssetImport: "asset.import",
  AssetMove: "asset.move",
  AssetDelete: "asset.delete",
  PrefabCreate: "prefab.create",
  PrefabInstantiate: "prefab.instantiate",
  PrefabApply: "prefab.apply",
  MaterialCreate: "material.create",
  MaterialUpdate: "material.update",
  ScriptRead: "script.read",
  ScriptWrite: "script.write",
  ScriptDelete: "script.delete",
  CameraCapture: "capture.camera",
  SceneCapture: "capture.scene",
  Batch: "batch",
  JobStart: "job.start",
  JobStatus: "job.status",
  JobCancel: "job.cancel",
  PackageList: "package.list",
  PackageAdd: "package.add",
  PackageRemove: "package.remove",
  Verify: "project.verify",
  ReadText: "asset.read-text",
  WriteText: "asset.write-text",
  BuildScenes: "scene.build-scenes",
  Types: "component.types",
  InspectType: "type.inspect",
} as const;

interface ToolGroup {
  description: string;
  operations: Record<string, string>;
  confirmation?: string;
}

/** Destructive operations have a separate consented entry point, including when a batch is used. */
export const UNITY_GROUPS: Record<string, ToolGroup> = {
  editor: {
    description:
      "Inspect Editor state, read console, or control Play mode. Check status before edits; do not replay an uncertain operation.",
    operations: {
      status: UnityMethod.Status,
      console: UnityMethod.Console,
      play: UnityMethod.Play,
      stop: UnityMethod.Stop,
      pause: UnityMethod.Pause,
      step: UnityMethod.Step,
    },
  },
  scene: {
    description:
      "List, create, open or save Unity scenes, or read build scenes. New/open scenes default to additive. Save dirty scenes before closing or replacement. Build-scene changes use the confirmed change tool.",
    operations: {
      list: UnityMethod.SceneList,
      create: UnityMethod.SceneCreate,
      open: UnityMethod.SceneOpen,
      save: UnityMethod.SceneSave,
      "build-scenes": UnityMethod.BuildScenes,
    },
  },
  hierarchy: {
    description:
      "Read a recursive, paginated Unity hierarchy. Follow nextOffset; use returned object IDs for subsequent operations. Saved scenes use stable GlobalObjectIds; unsaved scenes use explicit session IDs.",
    operations: { list: UnityMethod.Hierarchy },
  },
  object: {
    description:
      "Inspect, create or update a scene GameObject. Use an ID, never guess an ambiguous name. Edits participate in Unity Undo.",
    operations: {
      inspect: UnityMethod.ObjectInspect,
      create: UnityMethod.ObjectCreate,
      update: UnityMethod.ObjectUpdate,
    },
  },
  component: {
    description:
      "Discover component types and inspect, add or edit serialized properties on a component. Supports Unity subsystems through their real installed component types; inspect fields before setting them.",
    operations: {
      list: UnityMethod.ComponentList,
      types: UnityMethod.Types,
      "inspect-type": UnityMethod.InspectType,
      add: UnityMethod.ComponentAdd,
      get: UnityMethod.ComponentGet,
      set: UnityMethod.ComponentSet,
    },
  },
  asset: {
    description:
      "Search, inspect or import existing Assets files; read/write supported text assets with expectedSha256 when overwriting. Paths stay under Assets. Moving/deleting uses the confirmed change tool.",
    operations: {
      search: UnityMethod.AssetSearch,
      inspect: UnityMethod.AssetInspect,
      import: UnityMethod.AssetImport,
      "read-text": UnityMethod.ReadText,
      "write-text": UnityMethod.WriteText,
    },
  },
  prefab: {
    description: "Create a prefab, instantiate it or apply an instance's changes using Unity Prefab APIs.",
    operations: { create: UnityMethod.PrefabCreate, instantiate: UnityMethod.PrefabInstantiate },
  },
  material: {
    description:
      "Create or update a material using an installed shader and real shader properties. Inspect rendering pipeline and properties before changing them.",
    operations: { create: UnityMethod.MaterialCreate, update: UnityMethod.MaterialUpdate },
  },
  script: {
    description:
      "Read or write a C# script. An overwrite requires the SHA returned by read. After write wait for compilation to finish, inspect console errors, then attach its component.",
    operations: { read: UnityMethod.ScriptRead, write: UnityMethod.ScriptWrite },
  },
  capture: {
    description:
      "Capture a real camera or Scene view. Returns a bounded PNG for visual verification; capture success does not establish gameplay correctness.",
    operations: { camera: UnityMethod.CameraCapture, scene: UnityMethod.SceneCapture },
  },
  jobs: {
    description:
      "Inspect or cancel an accepted Editor job by its returned ID. Poll the same ID; never repeat creation merely because a response was lost. Building cannot be interrupted after Unity starts BuildPlayer.",
    operations: { status: UnityMethod.JobStatus, cancel: UnityMethod.JobCancel },
  },
  packages: {
    description:
      "List Unity packages through Package Manager. Listing returns a job; poll its ID. Package installation and removal use the confirmed change tool.",
    operations: { list: UnityMethod.PackageList },
  },
  change: {
    description:
      "Confirmed operations: delete, move, apply/overwrite prefab, package changes, Undo/Redo, scene replacement/closing or build-scene configuration. Dirty scenes must be saved first. Inspect the exact target before requesting consent.",
    operations: {
      "object-delete": UnityMethod.ObjectDelete,
      "component-remove": UnityMethod.ComponentRemove,
      "asset-delete": UnityMethod.AssetDelete,
      "script-delete": UnityMethod.ScriptDelete,
      "package-remove": UnityMethod.PackageRemove,
      undo: UnityMethod.Undo,
      redo: UnityMethod.Redo,
      "scene-open": UnityMethod.SceneOpen,
      "scene-close": UnityMethod.SceneClose,
      "scene-create": UnityMethod.SceneCreate,
      "asset-move": UnityMethod.AssetMove,
      "prefab-apply": UnityMethod.PrefabApply,
      "prefab-overwrite": UnityMethod.PrefabCreate,
      "package-add": UnityMethod.PackageAdd,
      "scene-overwrite": UnityMethod.SceneSave,
      "build-scenes": UnityMethod.BuildScenes,
    },
    confirmation:
      "Apply this Unity change to the connected project. Review its target and operation; deletion, moves, prefab changes and package changes can affect existing work.",
  },
};

/** Methods for which the Editor requires trusted confirmation. Ordinary batches cannot carry it. */
export const CONFIRMED_METHODS: ReadonlySet<string> = new Set([
  UnityMethod.ObjectDelete,
  UnityMethod.ComponentRemove,
  UnityMethod.AssetDelete,
  UnityMethod.ScriptDelete,
  UnityMethod.PackageRemove,
  UnityMethod.PackageAdd,
  UnityMethod.AssetMove,
  UnityMethod.PrefabApply,
  UnityMethod.Undo,
  UnityMethod.Redo,
]);

/** Structured parameters accept object form and the older coding CLIs' JSON-string form. */
export function unityParams(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === undefined) return {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Unity params must be an object.");
  const params = { ...parsed } as Record<string, unknown>;
  if (Object.hasOwn(params, "confirmed"))
    throw new Error("Unity confirmation is supplied by an approved tool, never by its arguments.");
  return params;
}

/** Conditional consent remains at the host boundary; the Editor independently refuses overwrite/replacement. */
export function normalUnityParams(method: string, value: unknown): Record<string, unknown> {
  const params = unityParams(value);
  if ((method === UnityMethod.SceneCreate || method === UnityMethod.SceneOpen) && params.additive === false)
    throw new Error("Replacing loaded scenes requires the confirmed Unity change tool; save dirty scenes first.");
  if (method === UnityMethod.BuildScenes && Object.hasOwn(params, "scenes"))
    throw new Error("Changing build scenes requires the confirmed Unity change tool.");
  return params;
}

/** Refuse a consent bypass in a batch before its first command reaches the Editor. */
export function safeUnityBatch(value: unknown): Record<string, unknown> {
  const params = unityParams(value);
  if (!Array.isArray(params.commands) || !params.commands.length || params.commands.length > 25)
    throw new Error("Unity batch requires 1 to 25 commands.");
  const allowed = new Set(
    Object.values(UNITY_GROUPS)
      .filter((group) => !group.confirmation)
      .flatMap((group) => Object.values(group.operations)),
  );
  params.commands = params.commands.map((command) => {
    if (!command || typeof command !== "object" || Array.isArray(command))
      throw new Error("Each Unity batch command must be an object.");
    const item = command as Record<string, unknown>;
    if (
      typeof item.method !== "string" ||
      !allowed.has(item.method) ||
      CONFIRMED_METHODS.has(item.method) ||
      item.method.startsWith("job.") ||
      item.method.startsWith("package.")
    )
      throw new Error("This operation cannot run in an ordinary Unity batch. Use its declared tool.");
    return { method: item.method, params: normalUnityParams(item.method, item.params) };
  });
  return params;
}
