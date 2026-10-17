/**
 * The builders' gate: a part enters the editor queue only when its own files pass, checked without
 * Unreal. Its declaration must read, it may own only Blueprints no other part owns, each
 * Blueprint's text is checked against the node reference, every Blueprint the game's parts
 * declare and the template's own Blueprints the editor exported, its play test must be one the queue can run, and it must have its `apply.py`. Every
 * problem names its file (and line), so a builder fixes them all in one go. A pin the reference
 * hasn't read yet is "unverified", never a failure, and so is a node a Blueprint may inherit from
 * the game's C++. A part's C++ needs the game's module and a computer that compiles it; each class
 * part.json lists needs its UCLASS in the part's headers, and the part changes no C++ but its own.
 */
import {
  type BlueprintDecl,
  classCategory,
  createNodeLookup,
  type NodeLookup,
  type ReferenceData,
} from "./blueprint-reference.ts";
import {
  type BlueprintProblem,
  checkGraphWrite,
  graphKindOf,
  type ProblemCode,
  Severity,
  splitByGraph,
} from "./blueprint-check.ts";
import { BlueprintTextError } from "./blueprint-text.ts";
import { declOf, type PartBlueprint, parsePartManifest } from "./part-manifest.ts";
import { parsePartTest } from "./part-test.ts";

/** What kind of problem the gate found. */
export const PartProblemCode = {
  Manifest: "manifest",
  Undeclared: "undeclared",
  Owned: "owned",
  Test: "test",
  Apply: "apply",
  Blueprint: "blueprint",
  /** The part's C++ files, its classes or where C++ can be written at all. */
  Cpp: "cpp",
  /** UnrealBuildTool's compile of the part's C++ in the builder's copy. */
  Compile: "compile",
} as const;
export type PartProblemCode = (typeof PartProblemCode)[keyof typeof PartProblemCode];

/** Whether this computer compiles Unreal C++: only a Mac whose Xcode is ready. */
export const CppSupport = { Ready: "ready", NotMac: "not-mac", NoXcode: "no-xcode" } as const;
export type CppSupport = (typeof CppSupport)[keyof typeof CppSupport];

/** The files a part folder holds. */
export const PartFile = { Manifest: "part.json", Test: "test.json", Apply: "apply.py", BlueprintText: ".dsl" } as const;

/** One problem, with the file (and line) a builder fixes it in. */
export type PartProblem = {
  file: string;
  line?: number;
  code: PartProblemCode;
  /** For Blueprint text: the checker's own code (`unknown-node`, `unknown-pin`, …). */
  detail?: ProblemCode;
  severity: Severity;
  message: string;
  suggestions?: string[];
};

/**
 * A part folder's contents as the gate reads them: parsed JSON (undefined when missing, with the
 * parse error when a file isn't JSON) and texts.
 */
export type PartFiles = {
  manifest: unknown;
  manifestError?: string;
  dsl: Record<string, string>;
  test: unknown;
  testError?: string;
  hasApply: boolean;
  /** apply.py's text, for the Python check. */
  apply?: string;
  /** The part's C++ in the builder's copy; undefined when the game has no linked project to read it from. */
  cpp?: PartCpp;
};
/**
 * A part's C++ as the gate reads it from the builder's copy: the game's module (undefined for a
 * Blueprint project), the part's own folder `unreal/Source/<Module>/Parts/<Part>` relative to the
 * copy, each header and source in it by its path inside that folder, what the folder can't hold
 * and every file changed outside it that UnrealBuildTool reads: the copy's Source, .uproject and
 * Plugins (both relative to the copy).
 */
export type PartCpp = {
  module: string | undefined;
  folder: string | undefined;
  files: Record<string, string>;
  problems: { file: string; message: string }[];
  outside: string[];
};
/** Another part of the same game, the Blueprints it declares and the C++ classes it defines. */
export type OtherPart = { part: string; blueprints: PartBlueprint[]; cpp?: string[] };
/** The gate's answer: pass when nothing is an error; unverified pins are counted, not failed. */
export type PartCheck = { ok: boolean; problems: PartProblem[]; unverified: number };
/** What the gate knows of the computer: whether it compiles C++ (not, unless said). */
export type PartCheckOptions = { cppSupport?: CppSupport };

const HEADER_EXTENSION = ".h";
/**
 * A UCLASS declaration in a header: `UCLASS(…)`, comments, then `class [<MODULE>_API] A<Name>` or
 * `U<Name>`; the name is captured without its prefix.
 */
const UCLASS_DECLARATION =
  /\bUCLASS\s*\((?:[^()]|\([^()]*\))*\)\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*class\s+(?:[A-Za-z0-9_]+_API\s+)?[AU]([A-Za-z][A-Za-z0-9_]*)\b/g;

const MESSAGE = {
  NoManifest: "part.json is missing: declare the part's Blueprints there first.",
  NoApply: "apply.py is missing: every part has one, even if it only places actors.",
  Undeclared: (file: string) => `${file} is Blueprint text for a Blueprint part.json doesn't declare.`,
  Owned: (name: string, other: string) =>
    `${name} already belongs to the part ${other}; two parts never own one Blueprint.`,
  NoReference: (file: string) =>
    `${file} was only parsed: the node reference isn't exported yet (it is once the game's project is open in Unreal).`,
  NoModule:
    "This game has no C++ module yet; Genex adds it before the Loop's first C++ part. Write this part in Blueprints and Python instead (empty part.json's cpp and remove its C++), or wait for the module.",
  NotMac:
    "C++ can't be compiled on this computer: Unreal C++ is compiled on a Mac with Xcode. Write this part in Blueprints and Python instead (empty part.json's cpp and remove its C++).",
  NoXcode:
    "C++ can't be compiled on this computer: Xcode isn't ready for this Unreal. Write this part in Blueprints and Python instead (empty part.json's cpp and remove its C++).",
  OwnedClass: (name: string, other: string) =>
    `C++ class ${name} already belongs to the part ${other}; two parts never define one class.`,
  MissingClass: (name: string, module: string, folder: string) =>
    `part.json's cpp lists ${name}, but no header in ${folder}/ declares it: write UCLASS() and then class ${module.toUpperCase()}_API A${name} (an actor) or U${name} (any other object).`,
  UndeclaredCpp: (folder: string) =>
    `${folder}/ holds C++, but part.json's cpp lists no class: list the UCLASS names it defines (without the A or U prefix), or remove the files.`,
  Outside: (folder: string) =>
    `changed outside this part's own C++ folder ${folder}/: a part changes no other C++, project file or plugin (not the module's files, not another part's). Put it back as the game has it.`,
  OutsideNoModule:
    "changed, but this game has no C++ module: a part writes C++ only into its own folder of the game's module. Put it back as the game has it.",
} as const;

const error = (file: string, code: PartProblemCode, message: string): PartProblem => ({
  file,
  code,
  severity: Severity.Error,
  message,
});

/**
 * What a part's Blueprint text may use besides the engine's nodes: the other parts' and the
 * template's Blueprints; and the lower-case names whose members may come from C++ the reference
 * can't see (the parts' C++ classes and the Blueprints made from them).
 */
type Known = { others: OtherPart[]; project: readonly BlueprintDecl[]; natives: ReadonlySet<string> };
/** The Blueprints the text may use and the names whose members may come from C++. */
type Usable = { blueprints: BlueprintDecl[]; natives: ReadonlySet<string> };

const CAST_PREFIX = "CastTo";
const lower = (text: string) => text.toLowerCase();

/** The other parts' Blueprints, and the template's that no part declares (a part's own declaration wins). */
function knownBlueprints(own: PartBlueprint[], known: Known): BlueprintDecl[] {
  const parts = known.others.flatMap((o) => o.blueprints).map(declOf);
  const declared = new Set([...own, ...parts].map((b) => b.name));
  return [...known.project.filter((b) => !declared.has(b.name)), ...parts];
}

/** The parts' C++ classes and the Blueprints made from them, lower case, also as Epic's member category spells them. */
function nativeNames(cpp: readonly string[], blueprints: PartBlueprint[], others: OtherPart[]): Set<string> {
  const classes = [...cpp, ...others.flatMap((o) => o.cpp ?? [])];
  const children = [...blueprints, ...others.flatMap((o) => o.blueprints)].filter((b) => b.parent !== undefined);
  const names = [...classes, ...children.map((b) => b.name)];
  return new Set(names.flatMap((name) => [name, classCategory(name).split("|").pop() ?? name]).map(lower));
}

/**
 * The lookup for one graph, where a node the reference lacks is unverified when it may come from
 * C++: anywhere in a Blueprint made from a C++ class, else when its id names such a class or child.
 */
function partLookup(lookup: NodeLookup, blueprint: PartBlueprint, natives: ReadonlySet<string>): NodeLookup {
  if (blueprint.parent !== undefined) return { ...lookup, unverifiable: () => true };
  if (natives.size === 0) return lookup;
  const named = (segment: string) =>
    natives.has(lower(segment)) ||
    (segment.startsWith(CAST_PREFIX) && natives.has(lower(segment.slice(CAST_PREFIX.length))));
  return { ...lookup, unverifiable: (typeId) => typeId.split("|").some(named) };
}

function textProblems(blueprint: PartBlueprint, text: string, reference: ReferenceData | null, usable: Usable) {
  const file = `${blueprint.name}${PartFile.BlueprintText}`;
  const own = declOf(blueprint);
  let writes: ReturnType<typeof splitByGraph>;
  try {
    writes = splitByGraph(blueprint.name, text);
  } catch (failure) {
    if (!(failure instanceof BlueprintTextError)) throw failure;
    return [{ ...error(file, PartProblemCode.Blueprint, failure.message), line: failure.line }];
  }
  if (!reference)
    return [
      { file, code: PartProblemCode.Blueprint, severity: Severity.Unverified, message: MESSAGE.NoReference(file) },
    ];
  return writes.flatMap((write) => {
    const engine = createNodeLookup(reference, blueprint.base, graphKindOf(write.graph), own, usable.blueprints);
    const lookup = partLookup(engine, blueprint, usable.natives);
    return checkGraphWrite(write, lookup, own).map((p: BlueprintProblem) => blueprintProblem(file, p));
  });
}

function blueprintProblem(file: string, problem: BlueprintProblem): PartProblem {
  return {
    file,
    line: problem.line,
    code: PartProblemCode.Blueprint,
    detail: problem.code,
    severity: problem.severity,
    message: problem.message,
    ...(problem.suggestions.length ? { suggestions: problem.suggestions } : {}),
  };
}

/** Blueprints this part declares that another part already owns. */
function ownedProblems(blueprints: PartBlueprint[], others: OtherPart[]): PartProblem[] {
  return blueprints.flatMap((b) => {
    const owner = others.find((o) => o.blueprints.some((theirs) => theirs.name === b.name));
    return owner ? [error(PartFile.Manifest, PartProblemCode.Owned, MESSAGE.Owned(b.name, owner.part))] : [];
  });
}

/** Every Blueprint text file the part holds, against what it declares. */
function blueprintsProblems(
  blueprints: PartBlueprint[],
  files: PartFiles,
  reference: ReferenceData | null,
  known: Known,
) {
  const declared = new Map(blueprints.map((b) => [`${b.name}${PartFile.BlueprintText}`, b]));
  const usable = { blueprints: knownBlueprints(blueprints, known), natives: known.natives };
  return Object.entries(files.dsl).flatMap(([file, text]) => {
    const blueprint = declared.get(file);
    if (!blueprint) return [error(file, PartProblemCode.Undeclared, MESSAGE.Undeclared(file))];
    return textProblems(blueprint, text, reference, usable);
  });
}

/** The UCLASS names the part's headers declare, without their A or U prefix. */
function declaredClasses(files: Record<string, string>): Set<string> {
  const names = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    if (!file.endsWith(HEADER_EXTENSION)) continue;
    for (const match of text.matchAll(UCLASS_DECLARATION)) if (match[1]) names.add(match[1]);
  }
  return names;
}

/** C++ classes this part lists that another part already defines. */
function ownedClassProblems(cpp: readonly string[], others: OtherPart[]): PartProblem[] {
  return cpp.flatMap((name) => {
    const owner = others.find((o) => o.cpp?.includes(name));
    return owner ? [error(PartFile.Manifest, PartProblemCode.Owned, MESSAGE.OwnedClass(name, owner.part))] : [];
  });
}

/** Why this computer can't compile the part's C++, if it can't. */
function supportProblem(support: CppSupport): PartProblem[] {
  if (support === CppSupport.Ready) return [];
  const message = support === CppSupport.NotMac ? MESSAGE.NotMac : MESSAGE.NoXcode;
  return [error(PartFile.Manifest, PartProblemCode.Cpp, message)];
}

/** The C++ the part holds against the classes it lists, in a game with its module where C++ compiles. */
function listedCppProblems(cpp: readonly string[], read: PartCpp | undefined, support: CppSupport): PartProblem[] {
  const { module, folder, files = {}, problems: unreadable = [] } = read ?? {};
  if (module === undefined || folder === undefined)
    return [error(PartFile.Manifest, PartProblemCode.Cpp, MESSAGE.NoModule)];
  const problems = [
    ...supportProblem(support),
    ...unreadable.map((p) => error(p.file, PartProblemCode.Cpp, p.message)),
  ];
  const declared = declaredClasses(files);
  for (const name of cpp.filter((c) => !declared.has(c)))
    problems.push(error(`${folder}/`, PartProblemCode.Cpp, MESSAGE.MissingClass(name, module, folder)));
  return problems;
}

/**
 * Every problem with the part's C++: classes another part defines, changes outside its own folder,
 * C++ part.json lists no class for, and (for a part with classes) the module, the computer, the
 * files and a UCLASS for each class. A part without C++ in a Blueprint game has none.
 */
function cppProblems(cpp: readonly string[], read: PartCpp | undefined, others: OtherPart[], support: CppSupport) {
  const outside = read?.outside ?? [];
  const where = read?.folder;
  const problems = [
    ...ownedClassProblems(cpp, others),
    ...outside.map((file) =>
      error(file, PartProblemCode.Cpp, where === undefined ? MESSAGE.OutsideNoModule : MESSAGE.Outside(where)),
    ),
  ];
  if (cpp.length > 0) return [...problems, ...listedCppProblems(cpp, read, support)];
  const holdsCpp = Object.keys(read?.files ?? {}).length + (read?.problems.length ?? 0) > 0;
  if (holdsCpp && where !== undefined)
    problems.push(error(PartFile.Manifest, PartProblemCode.Cpp, MESSAGE.UndeclaredCpp(where)));
  return problems;
}

/**
 * The gate for the part named `part`: its files, the node reference (null before the editor
 * exported it: Blueprint text is then only parsed), the game's other parts and the template's own
 * Blueprints as the editor exported them (`project-blueprints.ts`), and whether this computer
 * compiles C++ (`options.cppSupport`; not, unless said).
 */
export function checkPart(
  part: string,
  files: PartFiles,
  reference: ReferenceData | null,
  others: OtherPart[],
  project: readonly BlueprintDecl[] = [],
  options: PartCheckOptions = {},
): PartCheck {
  const elsewhere = others.filter((o) => o.part !== part);
  const problems: PartProblem[] = [];
  if (files.manifestError) problems.push(error(PartFile.Manifest, PartProblemCode.Manifest, files.manifestError));
  else if (files.manifest === undefined)
    problems.push(error(PartFile.Manifest, PartProblemCode.Manifest, MESSAGE.NoManifest));
  const manifest = files.manifest === undefined ? undefined : parsePartManifest(files.manifest);
  if (manifest && !manifest.ok)
    problems.push(...manifest.problems.map((m) => error(PartFile.Manifest, PartProblemCode.Manifest, m)));
  const blueprints = manifest?.ok ? manifest.part.blueprints : [];
  const cpp = manifest?.ok ? manifest.part.cpp : [];
  problems.push(...ownedProblems(blueprints, elsewhere));
  problems.push(...cppProblems(cpp, files.cpp, elsewhere, options.cppSupport ?? CppSupport.NoXcode));
  if (manifest?.ok) {
    const natives = nativeNames(cpp, blueprints, elsewhere);
    problems.push(...blueprintsProblems(blueprints, files, reference, { others: elsewhere, project, natives }));
  }
  const test = files.testError ? { ok: false as const, problems: [files.testError] } : parsePartTest(files.test);
  if (!test.ok) problems.push(...test.problems.map((m) => error(PartFile.Test, PartProblemCode.Test, m)));
  if (!files.hasApply) problems.push(error(PartFile.Apply, PartProblemCode.Apply, MESSAGE.NoApply));
  const unverified = problems.filter((p) => p.severity === Severity.Unverified).length;
  return { ok: problems.every((p) => p.severity !== Severity.Error), problems, unverified };
}
