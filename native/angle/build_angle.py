#!/usr/bin/env python3
"""Build one of Genex's pinned ANGLE targets from recipe.json and stage it with a manifest.

The same steps run on a developer Mac and in .github/workflows/angle.yml:

  1. depot_tools at the recipe's commit (cloned into --depot-tools when missing, never updated).
  2. A .gclient for the pinned ANGLE commit in --work, then a shallow `gclient sync` without
     history. Dependencies the target never builds are skipped.
  3. `gn gen` with the recipe's common and per-target args, then `autoninja` for the libraries.
  4. The outputs, the Khronos/ANGLE headers and the licence files of every third-party directory
     in the libraries' dependency graph are copied into --out. On macOS the install names are
     rewritten to @rpath and the dylibs are ad-hoc signed.
  5. The target's gate facts (imports, install names, glibc symbol versions; on Windows the PE
     machine, imports, delay imports and exports read by pe_imports.py, held to the recipe's
     allowedImports and requiredExports) are recorded in --out/manifest.json with a sha256 and size
     for every staged file. A gate failure exits 2 after the manifest is written.

Example (the local Mac build):

  python3 native/angle/build_angle.py --target macos-arm64-metal \\
    --depot-tools ~/Library/Caches/genex-dev-toolchains/depot_tools \\
    --work ~/Library/Caches/genex-dev-toolchains/angle-src \\
    --out ~/Library/Caches/genex-dev-toolchains/angle-metal-arm64/c5bf49e78850
"""

import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

from pe_imports import PeError, pe_facts

RECIPE_PATH = Path(__file__).with_name("recipe.json")
IS_WINDOWS = os.name == "nt"
LLVM_BIN = Path("third_party/llvm-build/Release+Asserts/bin")
LICENSE_NAMES = ("LICENSE", "LICENSE.txt", "LICENSE.TXT", "LICENSE.md", "COPYING", "NOTICE")
FOREIGN_GL_IMPORTS = ("OpenGL.framework", "libGL.so", "libGLX", "libOpenGL", "opengl32.dll")
GLIBC_VERSION = re.compile(r"GLIBC_(\d+(?:\.\d+)+)")
EXIT_GATE_FAILED = 2


def log(message):
    print(f"[build_angle] {message}", flush=True)


def run(cmd, cwd=None, env=None, capture=False):
    """Runs a command (echoed first); returns its stdout when capture is set."""
    log("$ " + " ".join(str(part) for part in cmd))
    result = subprocess.run(
        [str(part) for part in cmd],
        cwd=cwd,
        env=env,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else ""


def depot_env(depot_tools):
    """The environment every depot_tools call runs in: pinned (no self-update), no metrics."""
    env = dict(os.environ)
    env["PATH"] = str(depot_tools) + os.pathsep + env.get("PATH", "")
    env.update(DEPOT_TOOLS_UPDATE="0", DEPOT_TOOLS_METRICS="0", DEPOT_TOOLS_WIN_TOOLCHAIN="0")
    return env


def depot_tool(env, name):
    """A depot_tools wrapper; on Windows the .bat, never the bash script of the same name."""
    found = shutil.which(name + ".bat" if IS_WINDOWS else name, path=env["PATH"])
    if not found:
        sys.exit(f"{name} is not on PATH; is depot_tools bootstrapped?")
    return found


def ensure_depot_tools(recipe, path, env):
    """Clones depot_tools at the pinned commit when missing and bootstraps its Python and CIPD tools."""
    pin = recipe["depotTools"]["commit"]
    if not (path / ".git").exists():
        path.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "-q", path])
        run(["git", "-C", path, "fetch", "-q", "--depth", "1", recipe["depotTools"]["repo"], pin])
        run(["git", "-C", path, "checkout", "-q", "--detach", "FETCH_HEAD"])
    head = run(["git", "-C", path, "rev-parse", "HEAD"], capture=True).strip()
    if head != pin:
        sys.exit(f"depot_tools at {path} is {head}; the recipe pins {pin}")
    bootstrap = path / "bootstrap" / "win_tools.bat" if IS_WINDOWS else path / "ensure_bootstrap"
    # ensure_bootstrap ends with a luci-auth probe that fails harmlessly off Google machines.
    subprocess.run([str(bootstrap)], cwd=path, env=env, check=IS_WINDOWS)


def gclient_file(recipe, target):
    skip = recipe["gclient"]["skipDeps"] + target.get("skipDeps", [])
    solution = {
        "name": ".",
        "url": f"{recipe['angle']['repo']}@{recipe['angle']['commit']}",
        "deps_file": "DEPS",
        "managed": False,
        "custom_deps": {dep: None for dep in skip},
        "custom_vars": recipe["gclient"]["customVars"],
    }
    return f"solutions = [{solution!r}]\ntarget_os = {target['gclientTargetOs']!r}\n"


def sync(recipe, target, work, env, jobs):
    work.mkdir(parents=True, exist_ok=True)
    (work / ".gclient").write_text(gclient_file(recipe, target))
    command = [depot_tool(env, "gclient"), "sync", "--no-history", "--shallow", "-j", str(jobs)]
    run(command, cwd=work, env=env)
    head = run(["git", "-C", work, "rev-parse", "HEAD"], capture=True).strip()
    if head != recipe["angle"]["commit"]:
        sys.exit(f"ANGLE checkout is at {head}; the recipe pins {recipe['angle']['commit']}")


def gn_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    return str(value)


def gn_args(recipe, target):
    return {**recipe["commonGnArgs"], **target["gnArgs"]}


def build(recipe, target_name, target, work, env):
    out_dir = work / "out" / target_name
    out_dir.mkdir(parents=True, exist_ok=True)
    args = gn_args(recipe, target)
    (out_dir / "args.gn").write_text("".join(f"{key} = {gn_value(args[key])}\n" for key in sorted(args)))
    run([depot_tool(env, "gn"), "gen", out_dir.relative_to(work)], cwd=work, env=env)
    run([depot_tool(env, "autoninja"), "-C", out_dir.relative_to(work), *target["buildTargets"]], cwd=work, env=env)
    return out_dir


def first_line(cmd, cwd=None):
    try:
        output = subprocess.run(cmd, cwd=cwd, check=True, text=True, capture_output=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return output.strip().splitlines()[0] if output.strip() else None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_outputs(target, out_dir, stage):
    for name in target["outputs"]:
        source = out_dir / name
        if not source.is_file():
            produced = sorted(path.name for path in out_dir.iterdir() if path.is_file())
            sys.exit(f"expected build output {source} is missing; {out_dir} has: {', '.join(produced)}")
        shutil.copy2(source, stage / name)


def stage_headers(recipe, work, stage):
    # Dotfiles (ANGLE keeps a .clang-format in each include dir) are not headers, and
    # actions/upload-artifact drops hidden files: staged, they would be in the manifest but not the artifact.
    for relative in recipe["headers"]:
        shutil.copytree(work / relative, stage / relative, ignore=shutil.ignore_patterns(".*"))


def third_party_dir(label):
    """Maps a GN label to the third-party directory that owns it (the deepest third_party/<name>)."""
    path = label.split(":")[0].lstrip("/")
    matches = list(re.finditer(r"third_party/[^/]+", path))
    if not matches:
        return None
    owner = path[: matches[-1].end()]
    return owner.replace("buildtools/third_party/", "third_party/", 1)


def license_files(work, directory):
    """The licence files a README.chromium names for a directory, else the conventional names."""
    readme = work / directory / "README.chromium"
    named = []
    if readme.is_file():
        for line in readme.read_text(errors="replace").splitlines():
            if line.startswith("License File:"):
                named += [part.strip() for part in line.split(":", 1)[1].split(",")]
    found = []
    for name in named:
        candidate = work / name.lstrip("/") if name.startswith("//") else work / directory / name
        if candidate.is_file():
            found.append(candidate)
    if found:
        return found
    for folder in (work / directory, work / directory / "src"):
        found += [folder / name for name in LICENSE_NAMES if (folder / name).is_file()]
    return found


def stage_licenses(target, work, out_dir, env, stage):
    """Copies ANGLE's licence and one per third-party directory in the build graph into licenses/."""
    destination = stage / "licenses"
    destination.mkdir()
    shutil.copy2(work / "LICENSE", destination / "angle.txt")
    labels = set()
    for build_target in target["buildTargets"]:
        command = [depot_tool(env, "gn"), "desc", out_dir.relative_to(work), f"//:{build_target}", "deps", "--all"]
        listing = run(command, cwd=work, env=env, capture=True)
        labels.update(line.strip() for line in listing.splitlines() if line.startswith("//"))
    # ANGLE's own src/third_party code is compiled into libANGLE directly, so every directory counts.
    vendored = {path.relative_to(work).as_posix() for path in (work / "src" / "third_party").iterdir() if path.is_dir()}
    directories = sorted({owner for owner in map(third_party_dir, labels) if owner} | vendored)
    missing = []
    for directory in directories:
        files = license_files(work, directory)
        if not files:
            missing.append(directory)
        for index, source in enumerate(files):
            suffix = f"-{index + 1}" if len(files) > 1 else ""
            shutil.copy2(source, destination / (directory.replace("/", "_") + suffix + ".txt"))
    return {"directories": directories, "missing": missing}


def mac_facts(target, stage):
    """Rewrites install names to @rpath, ad-hoc signs, then records the Metal gate facts."""
    facts, failures = {}, []
    for name in target["outputs"]:
        path = stage / name
        install_name = target.get("installNames", {}).get(name)
        if install_name:
            run(["install_name_tool", "-id", install_name, path])
        run(["codesign", "--sign", "-", "--force", path])
        imports = run(["otool", "-L", path], capture=True).splitlines()[1:]
        imports = [line.strip() for line in imports]
        signature = subprocess.run(["codesign", "-dv", str(path)], text=True, capture_output=True).stderr
        load_commands = run(["otool", "-l", path], capture=True)
        minos = re.search(r"LC_BUILD_VERSION.*?minos (\S+)", load_commands, re.S)
        facts[name] = {
            "installName": run(["otool", "-D", path], capture=True).splitlines()[-1].strip(),
            "archs": run(["lipo", "-archs", path], capture=True).strip(),
            "minos": minos.group(1) if minos else None,
            "imports": imports,
            "signature": [line for line in signature.splitlines() if line.startswith(("Signature", "CodeDirectory"))],
        }
        failures += [f"{name} imports {line}" for line in imports if any(gl in line for gl in FOREIGN_GL_IMPORTS)]
        if install_name and facts[name]["installName"] != install_name:
            failures.append(f"{name} install name is {facts[name]['installName']}")
    if not any("/Metal.framework/" in line for line in facts.get("libGLESv2.dylib", {}).get("imports", [])):
        failures.append("libGLESv2.dylib does not link Metal.framework")
    return facts, failures


def linux_facts(target, stage):
    """Records each ELF's imports, RUNPATH and highest glibc symbol version."""
    facts, failures = {}, []
    limit = tuple(int(part) for part in target["maxGlibc"].split("."))
    for name in target["outputs"]:
        path = stage / name
        if path.suffix == ".json":
            continue
        dynamic = run(["readelf", "-d", path], capture=True)
        needed = re.findall(r"\(NEEDED\).*\[(.+?)\]", dynamic)
        runpath = re.findall(r"\((?:RUNPATH|RPATH)\).*\[(.+?)\]", dynamic)
        versions = {
            tuple(int(part) for part in found.split("."))
            for found in GLIBC_VERSION.findall(run(["objdump", "-T", path], capture=True))
        }
        highest = max(versions) if versions else None
        facts[name] = {
            "needed": needed,
            "runpath": runpath,
            "maxGlibc": ".".join(map(str, highest)) if highest else None,
        }
        failures += [f"{name} needs {lib}" for lib in needed if any(gl in lib for gl in FOREIGN_GL_IMPORTS)]
        if highest and highest > limit:
            failures.append(f"{name} needs GLIBC_{facts[name]['maxGlibc']} (limit {target['maxGlibc']})")
    return facts, failures


def dll_failures(target, name, pe):
    """What the recipe refuses in one DLL: a foreign machine, a GL import, an unlisted import or a missing export."""
    failures = []
    if pe["machine"] != target["peMachine"] or not pe["dll"]:
        kind = "DLL" if pe["dll"] else "executable"
        failures.append(f"{name} is a {pe['machine']} {kind}, not a {target['peMachine']} DLL")
    allowed = {dll.lower() for dll in target["allowedImports"].get(name, [])}
    for dll in pe["imports"] + pe["delayImports"]:
        if any(gl.lower() in dll.lower() for gl in FOREIGN_GL_IMPORTS):
            failures.append(f"{name} imports {dll}")
        elif dll.lower() not in allowed:
            failures.append(f"{name} imports {dll}, which the recipe's allowedImports does not list")
    exported = set(pe["exports"])
    missing = [symbol for symbol in target["requiredExports"].get(name, []) if symbol not in exported]
    return failures + [f"{name} does not export {symbol}" for symbol in missing]


def windows_facts(target, stage):
    """Reads every staged DLL's PE headers (no toolchain needed) and holds them to the recipe."""
    facts, failures = {}, []
    names = sorted({name for name in target["outputs"] if name.endswith(".dll")} | set(target["allowedImports"]))
    for name in names:
        try:
            pe = pe_facts((stage / name).read_bytes())
        except (OSError, PeError) as error:
            failures.append(f"{name} is not a readable PE image: {error}")
            continue
        facts[name] = {
            "machine": pe["machine"],
            "imports": pe["imports"],
            "delayImports": pe["delayImports"],
            "exports": len(pe["exports"]),
        }
        failures += dll_failures(target, name, pe)
    return facts, failures


def gate_facts(target, stage):
    if sys.platform == "darwin":
        return mac_facts(target, stage)
    if sys.platform.startswith("linux"):
        return linux_facts(target, stage)
    return windows_facts(target, stage)


def host_facts(work):
    clang = work / LLVM_BIN / ("clang-cl.exe" if IS_WINDOWS else "clang")
    facts = {"platform": platform.platform(), "clang": first_line([str(clang), "--version"])}
    if sys.platform == "darwin":
        facts["xcode"] = " ".join(
            subprocess.run(["xcodebuild", "-version"], text=True, capture_output=True).stdout.split()
        )
        facts["sdk"] = first_line(["xcrun", "--show-sdk-version"])
        component = subprocess.run(
            ["xcodebuild", "-showComponent", "MetalToolchain"], text=True, capture_output=True
        ).stdout
        facts["metalToolchain"] = next(
            (line.split(":", 1)[1].strip() for line in component.splitlines() if line.startswith("Build Version")), None
        )
    return facts


def file_table(stage):
    table = {}
    for path in sorted(stage.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            table[path.relative_to(stage).as_posix()] = {"sha256": sha256(path), "size": path.stat().st_size}
    return table


def stage_and_manifest(recipe, target_name, target, work, out_dir, env, stage):
    if stage.exists() and any(stage.iterdir()):
        sys.exit(f"{stage} is not empty; stage into a new directory")
    stage.mkdir(parents=True, exist_ok=True)
    stage_outputs(target, out_dir, stage)
    stage_headers(recipe, work, stage)
    licenses = stage_licenses(target, work, out_dir, env, stage)
    facts, failures = gate_facts(target, stage)
    manifest = {
        "schema": 1,
        "target": target_name,
        "commit": recipe["angle"]["commit"],
        "chromium": recipe["chromium"],
        "electron": recipe["electron"],
        "depotTools": recipe["depotTools"]["commit"],
        "gnArgs": gn_args(recipe, target),
        "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "host": host_facts(work),
        "facts": facts,
        "gateFailures": failures,
        "licenses": licenses,
        "files": file_table(stage),
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", required=True)
    parser.add_argument("--depot-tools", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path, help="ANGLE checkout (gclient root)")
    parser.add_argument("--out", required=True, type=Path, help="empty staging directory")
    parser.add_argument("--skip-sync", action="store_true", help="reuse an existing checkout as is")
    parser.add_argument("--jobs", type=int, default=8)
    options = parser.parse_args()
    recipe = json.loads(RECIPE_PATH.read_text())
    target = recipe["targets"].get(options.target)
    if target is None:
        sys.exit(f"unknown target {options.target}; the recipe has {', '.join(recipe['targets'])}")
    depot_tools, work, stage = (
        path.expanduser().resolve() for path in (options.depot_tools, options.work, options.out)
    )
    env = depot_env(depot_tools)
    ensure_depot_tools(recipe, depot_tools, env)
    if not options.skip_sync:
        sync(recipe, target, work, env, options.jobs)
    out_dir = build(recipe, options.target, target, work, env)
    manifest = stage_and_manifest(recipe, options.target, target, work, out_dir, env, stage)
    for name in target["outputs"]:
        entry = manifest["files"][name]
        log(f"{name}  {entry['size']} B  sha256 {entry['sha256']}")
    if manifest["gateFailures"]:
        log("gate failures: " + "; ".join(manifest["gateFailures"]))
        return EXIT_GATE_FAILED
    log(f"staged {options.target} into {stage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
