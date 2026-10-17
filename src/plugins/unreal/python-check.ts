/**
 * Checks a part's `apply.py` before the editor queue runs it: Python parses it (it is never
 * run), every `genex.<name>` it reads is checked against the helper's `genex` module (`GENEX_NAMES`),
 * and every `unreal.<Name>` and `unreal.<Class>.<member>` against the
 * names the user's own engine exports (the Genex editor helper's `export_python_names`). The
 * product runs Unreal's bundled Python 3.11; no new dependency, no developer-mode stub. In a game
 * with a C++ module, the parts' own classes exist only after the hot reload: `unreal.<Class>` of
 * one passes, a method no engine class has is unverified on what one of them made (a name bound
 * from `unreal.<Class>` or `unreal.load_class(None, '/Script/<Module>.<Class>')`, or from such a
 * name) and still an error on anything else, and an unknown `unreal.<Name>` is told that
 * `load_class` is the reliable form.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";

/** What a problem is. */
export const PythonProblemCode = {
  Syntax: "syntax",
  UnknownName: "unknown-name",
  Unavailable: "unavailable",
  /** A method no engine class has, in a game whose C++ may add it: the editor checks it. */
  Unverified: "unverified",
} as const;
export type PythonProblemCode = (typeof PythonProblemCode)[keyof typeof PythonProblemCode];

/** One problem in a script, by line, with the names it most likely meant. */
export type PythonProblem = { code: PythonProblemCode; line: number; message: string; suggestions?: string[] };

/**
 * The names of the `genex` module a part's apply.py gets (the Genex editor helper's
 * `genex_loop/part_api.py` `for_part`); `unreal-editor-helper-python.test.ts` holds the two to one list.
 */
export const GENEX_NAMES = [
  "add_component",
  "blueprint",
  "build_part",
  "compile",
  "folder",
  "import_model",
  "import_sound",
  "import_texture",
  "part",
  "place",
  "save",
  "write_graph",
] as const;

/** A C++ game's module and the classes its parts define (without the A or U prefix). */
export type PythonCpp = { module: string; classes: readonly string[] };

/**
 * The Python to run, the exported names file (null while the engine hasn't exported them yet) and,
 * in a game with a C++ module, its module and classes.
 */
export type PythonCheckEnv = { python: string; names: string | null; cpp?: PythonCpp };

/** Unreal's own Python 3 inside an engine folder. */
export function unrealPython(engineDirectory: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const python = paths.join(engineDirectory, "Engine", "Binaries", "ThirdParty", "Python3");
  if (platform === "win32") return paths.join(python, "Win64", "python.exe");
  return paths.join(python, platform === "darwin" ? "Mac" : "Linux", "bin", "python3");
}

/** How long one check may take before it counts as unavailable. */
const CHECK_TIMEOUT_MS = 20 * SECOND_MS;
/** The largest answer a check reads back. */
const MAX_ANSWER_BYTES = 256 * 1024;

const MESSAGE = {
  Unavailable: (why: string) => `apply.py couldn't be checked: ${why}`,
} as const;

/** The checker Python runs: reads `{source, names, cpp, genex}` on stdin, prints the problems as JSON. */
const CHECKER = String.raw`
import ast, difflib, json, sys
request = json.load(sys.stdin)
problems = []
try:
    tree = ast.parse(request["source"], filename="apply.py")
except SyntaxError as error:
    print(json.dumps([{"code": "syntax", "line": error.lineno or 1, "message": "apply.py: " + str(error.msg)}]))
    sys.exit(0)
genex_names = request.get("genex") or []
for node in ast.walk(tree):
    reads_genex = isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "genex"
    if reads_genex and isinstance(node.ctx, ast.Load) and node.attr not in genex_names:
        problems.append({"code": "unknown-name", "line": node.lineno,
                         "message": "apply.py: genex." + node.attr + " isn't one of the genex module's names",
                         "suggestions": difflib.get_close_matches(node.attr, genex_names, 3)})
names = None
if request.get("names"):
    with open(request["names"], encoding="utf-8") as handle:
        names = json.load(handle)
cpp = request.get("cpp") or {}
cpp_classes = set(cpp.get("classes") or [])
cpp_paths = {"/Script/" + cpp["module"] + "." + name for name in cpp_classes} if cpp.get("module") else set()
def unknown(line, written, wanted, choices, hint=""):
    problems.append({"code": "unknown-name", "line": line, "message": "apply.py: " + written + " doesn't exist in this engine" + hint,
                     "suggestions": difflib.get_close_matches(wanted, choices, 3)})
def unverified(line, written):
    problems.append({"code": "unverified", "line": line,
                     "message": "apply.py: " + written + " isn't one of the engine's names; it may come from the game's C++, so the editor checks it"})
def load_class_hint(name):
    if not cpp.get("module"):
        return ""
    return "; a C++ class of this game is reached reliably with unreal.load_class(None, '/Script/" + cpp["module"] + "." + name + "')"
def made_by_cpp(expr, derived):
    """Whether expr names one of the parts' C++ classes (unreal.<Class>, load_class of its path) or a name bound from one."""
    for sub in ast.walk(expr):
        if isinstance(sub, ast.Name) and sub.id in derived:
            return True
        if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name) and sub.value.id == "unreal" and sub.attr in cpp_classes:
            return True
        loads = isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == "load_class"
        if loads and any(isinstance(arg, ast.Constant) and arg.value in cpp_paths for arg in sub.args):
            return True
    return False
def cpp_bound(tree):
    """Every name bound, directly or through other names, from one of the parts' C++ classes."""
    derived = set()
    bindings = [(node.targets, node.value) for node in ast.walk(tree) if isinstance(node, ast.Assign)]
    bindings += [([node.target], node.iter) for node in ast.walk(tree) if isinstance(node, ast.For)]
    grew = bool(cpp_classes)
    while grew:
        grew = False
        for targets, value in bindings:
            if not made_by_cpp(value, derived):
                continue
            for target in targets:
                for name in ast.walk(target):
                    if isinstance(name, ast.Name) and name.id not in derived:
                        derived.add(name.id)
                        grew = True
    return derived
def cpp_method_hint():
    if not cpp.get("module"):
        return ""
    return "; a method of this game's C++ is checked on what its class made (a name bound from unreal.load_class(None, '/Script/" + cpp["module"] + ".<Class>'))"
if names is not None:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        inner = node.value
        if isinstance(inner, ast.Name) and inner.id == "unreal" and node.attr not in names and node.attr not in cpp_classes:
            unknown(node.lineno, "unreal." + node.attr, node.attr, list(names), load_class_hint(node.attr))
        elif isinstance(inner, ast.Attribute) and isinstance(inner.value, ast.Name) and inner.value.id == "unreal":
            members = names.get(inner.attr)
            if isinstance(members, list) and node.attr not in members:
                unknown(node.lineno, "unreal." + inner.attr + "." + node.attr, node.attr, members)
    # Method calls on objects: checked against the object's class when the script made or found it
    # as one (unreal.Class(...), get_component_by_class(unreal.Class)), else against every class.
    every = set()
    for members in names.values():
        if isinstance(members, list):
            every.update(members)
    python_members = set()
    for kind in (str, bytes, list, dict, set, tuple, int, float, bool, object):
        python_members.update(dir(kind))
    modules = {"unreal", "genex", "part"}
    defined = set()
    bound = {}
    def unreal_class(expr):
        is_path = isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name) and expr.value.id == "unreal"
        return expr.attr if is_path and isinstance(names.get(expr.attr), list) else None
    def root_name(expr):
        while isinstance(expr, ast.Attribute):
            expr = expr.value
        return expr.id if isinstance(expr, ast.Name) else None
    def class_made_by(value):
        if not isinstance(value, ast.Call):
            return None
        made = unreal_class(value.func)
        if made:
            return made
        finds = isinstance(value.func, ast.Attribute) and value.func.attr == "get_component_by_class"
        return unreal_class(value.args[0]) if finds and value.args else None
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            modules.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bound.setdefault(target.id, set()).add(class_made_by(node.value))
    known = {name: next(iter(kinds)) for name, kinds in bound.items() if len(kinds) == 1 and None not in kinds}
    from_cpp = cpp_bound(tree)
    def property_hint(method):
        prop = method[4:] if method.startswith("set_") else ""
        return '; it is a property: set_editor_property("' + prop + '", value)' if prop in every else ""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        receiver, method = node.func.value, node.func.attr
        if method.startswith("_") or method in defined or unreal_class(receiver):
            continue
        if root_name(receiver) in modules:
            continue
        if isinstance(receiver, ast.Name) and receiver.id in known:
            kind = known[receiver.id]
            if method not in names[kind]:
                written = receiver.id + "." + method + " (a " + kind + ")"
                unknown(node.lineno, written, method, names[kind], property_hint(method))
        elif method in every or method in python_members:
            continue
        elif made_by_cpp(receiver, from_cpp):
            unverified(node.lineno, "." + method + "()")
        else:
            unknown(node.lineno, "." + method + "()", method, sorted(every), property_hint(method) + cpp_method_hint())
seen = set()
unique = []
for problem in sorted(problems, key=lambda p: p["line"]):
    key = (problem["line"], problem["message"])
    if key not in seen:
        seen.add(key)
        unique.append(problem)
print(json.dumps(unique))
`;

/** Runs the checker; resolves with its stdout, rejects when Python can't run or takes too long. */
function runChecker(python: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", "-c", CHECKER], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), CHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`Python exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const isProblem = (value: unknown): value is PythonProblem =>
  Boolean(value) && typeof value === "object" && typeof (value as PythonProblem).line === "number";

/** Every problem Python and the engine's names find in `source`. */
export async function checkPython(env: PythonCheckEnv, source: string): Promise<PythonProblem[]> {
  try {
    const request = { source, names: env.names, cpp: env.cpp ?? null, genex: GENEX_NAMES };
    const answer = await runChecker(env.python, JSON.stringify(request));
    const parsed: unknown = JSON.parse(answer);
    return Array.isArray(parsed) ? parsed.filter(isProblem) : [];
  } catch (failure) {
    return [{ code: PythonProblemCode.Unavailable, line: 1, message: MESSAGE.Unavailable(errorMessage(failure)) }];
  }
}
