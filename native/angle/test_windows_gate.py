"""Tests for the Windows DLL gate (build_angle.py) and the PE reader behind it (pe_imports.py).

The fixtures are real PE images cross-compiled with zig (cc, dlltool, lld-link), so the reader is
checked against the linker's own layout. Without zig the tests skip; point GENEX_ZIG at a zig
binary or keep the dev toolchain store's copy.

  python3 -m unittest discover -s native/angle -p "test_*.py"
"""

import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import build_angle  # noqa: E402
from pe_imports import PeError, pe_facts  # noqa: E402

STORE_ZIG = Path.home() / "Library/Caches/genex-dev-toolchains/zig-0.16.0/zig"
ZIG = os.environ.get("GENEX_ZIG") or shutil.which("zig") or (str(STORE_ZIG) if STORE_ZIG.is_file() else None)
TRIPLES = {"x64": ("x86_64-windows-gnu", "i386:x86-64"), "x86": ("x86-windows-gnu", "i386")}
EGL_EXPORTS = ("eglGetPlatformDisplay", "eglGetProcAddress")
GLES_EXPORTS = ("glDrawArrays",)
KERNEL32 = {"KERNEL32.dll": ["GetModuleHandleA"]}
GLES_IMPORTS = {**KERNEL32, "USER32.dll": ["MessageBoxA"]}
TARGET = {
    "outputs": ["libEGL.dll", "libEGL.dll.lib", "libGLESv2.dll"],
    "peMachine": "x64",
    "allowedImports": {"libEGL.dll": ["kernel32.dll"], "libGLESv2.dll": ["KERNEL32.dll", "user32.dll"]},
    "requiredExports": {"libEGL.dll": list(EGL_EXPORTS), "libGLESv2.dll": list(GLES_EXPORTS)},
}


def zig(*args, cwd):
    subprocess.run([ZIG, *args], cwd=cwd, check=True, capture_output=True)


def build_dll(directory, name, imports, exports, delay=(), machine="x64"):
    """Links a DLL that imports each {dll: [functions]} entry and exports the given names."""
    triple, dlltool_machine = TRIPLES[machine]
    work = Path(tempfile.mkdtemp(dir=directory))
    functions = [function for names in imports.values() for function in names]
    calls = " + ".join(f"(int)(long long){function}(0, 0, 0, 0)" for function in functions) or "0"
    source = [f"__declspec(dllimport) void *{function}(void *, void *, void *, unsigned);" for function in functions]
    source += [f"__declspec(dllexport) int {export}(void) {{ return {calls}; }}" for export in exports]
    # lld-link needs the delay-load helper symbol; the fixture is never run, so a stub will do.
    source.append("void *__delayLoadHelper2(const void *descriptor, void **slot) { return 0; }")
    (work / "fixture.c").write_text("\n".join(source) + "\n")
    # zig cc instruments debug builds with UBSan, whose runtime a -nostdlib link does not have.
    zig("cc", "-target", triple, "-O2", "-fno-sanitize=all", "-c", "-o", "fixture.o", "fixture.c", cwd=work)
    libraries = []
    for index, (dll, names) in enumerate(imports.items()):
        (work / f"import{index}.def").write_text(f"LIBRARY {dll}\nEXPORTS\n" + "\n".join(names) + "\n")
        zig("dlltool", "-m", dlltool_machine, "-d", f"import{index}.def", "-l", f"import{index}.lib", cwd=work)
        libraries.append(f"import{index}.lib")
    output = Path(directory) / name
    delay_flags = [f"/delayload:{dll}" for dll in delay]
    zig("lld-link", "-lldmingw", "/dll", "/noentry", f"/machine:{machine}", f"/out:{output}", "fixture.o", *libraries, *delay_flags, cwd=work)
    return output


@unittest.skipUnless(ZIG, "zig is not available (set GENEX_ZIG)")
class PeReaderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.dll = build_dll(cls.tmp, "sample.dll", GLES_IMPORTS, GLES_EXPORTS).read_bytes()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_reads_machine_imports_and_exports_of_an_x64_dll(self):
        facts = pe_facts(self.dll)
        self.assertEqual(facts["machine"], "x64")
        self.assertTrue(facts["dll"])
        self.assertEqual(sorted(facts["imports"]), ["KERNEL32.dll", "USER32.dll"])
        self.assertEqual(facts["delayImports"], [])
        self.assertIn("glDrawArrays", facts["exports"])

    def test_reads_delay_imports_separately(self):
        path = build_dll(self.tmp, "delayed.dll", GLES_IMPORTS, GLES_EXPORTS, delay=["USER32.dll"])
        facts = pe_facts(path.read_bytes())
        self.assertEqual(facts["imports"], ["KERNEL32.dll"])
        self.assertEqual(facts["delayImports"], ["USER32.dll"])

    def test_reads_a_pe32_x86_dll(self):
        facts = pe_facts(build_dll(self.tmp, "x86.dll", KERNEL32, EGL_EXPORTS, machine="x86").read_bytes())
        self.assertEqual((facts["machine"], facts["dll"], facts["imports"]), ("x86", True, ["KERNEL32.dll"]))

    def test_hostile_images_raise_pe_error(self):
        pe = struct.unpack_from("<I", self.dll, 0x3C)[0]
        optional = pe + 24
        import_directory = optional + 112 + 8

        def patched(offset, fmt, value):
            data = bytearray(self.dll)
            struct.pack_into(fmt, data, offset, value)
            return bytes(data)

        cases = {
            "empty file": b"",
            "ELF image": b"\x7fELF" + bytes(60),
            "truncated after the DOS header": self.dll[:0x40],
            "PE header offset past the end": patched(0x3C, "<I", 0xFFFFFFF0),
            "broken PE signature": patched(pe, "<4s", b"PX\0\0"),
            "ROM optional header": patched(optional, "<H", 0x107),
            "65535 section headers": patched(pe + 6, "<H", 0xFFFF),
            "import directory outside every section": patched(import_directory, "<I", 0x7FFFFFF0),
            "import directory truncated by the file": self.dll[: len(self.dll) // 2],
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(PeError):
                pe_facts(data)


@unittest.skipUnless(ZIG, "zig is not available (set GENEX_ZIG)")
class WindowsGateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        fixtures = Path(cls.tmp) / "fixtures"
        fixtures.mkdir()
        cls.egl = build_dll(fixtures, "egl.dll", KERNEL32, EGL_EXPORTS)
        cls.gles = build_dll(fixtures, "gles.dll", GLES_IMPORTS, GLES_EXPORTS)
        cls.variants = {
            "opengl32": build_dll(fixtures, "gl.dll", {**GLES_IMPORTS, "OPENGL32.dll": ["glClear"]}, GLES_EXPORTS),
            "delayed opengl32": build_dll(
                fixtures, "gld.dll", {**GLES_IMPORTS, "opengl32.dll": ["glClear"]}, GLES_EXPORTS, delay=["opengl32.dll"]
            ),
            "gdi32": build_dll(fixtures, "gdi.dll", {**GLES_IMPORTS, "GDI32.dll": ["GetStockObject"]}, GLES_EXPORTS),
            "no eglGetProcAddress": build_dll(fixtures, "egl-short.dll", KERNEL32, EGL_EXPORTS[:1]),
            "x86": build_dll(fixtures, "egl-x86.dll", KERNEL32, EGL_EXPORTS, machine="x86"),
        }

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def stage(self, egl=None, gles=None):
        stage = Path(tempfile.mkdtemp(dir=self.tmp))
        for name, source in (("libEGL.dll", egl or self.egl), ("libGLESv2.dll", gles or self.gles)):
            if source != "absent":
                shutil.copy(source, stage / name)
        (stage / "libEGL.dll.lib").write_bytes(b"!<arch>\n")
        return stage

    def gate(self, stage):
        # The gate reads the files itself: no ANGLE checkout or toolchain is involved.
        with mock.patch.object(build_angle.sys, "platform", "win32"):
            return build_angle.gate_facts(TARGET, stage)

    def test_a_matching_build_passes_and_records_every_dll(self):
        facts, failures = self.gate(self.stage())
        self.assertEqual(failures, [])
        self.assertEqual(facts["libEGL.dll"]["imports"], ["KERNEL32.dll"])
        self.assertEqual(sorted(facts["libGLESv2.dll"]["imports"]), ["KERNEL32.dll", "USER32.dll"])
        self.assertEqual(facts["libGLESv2.dll"]["machine"], "x64")

    def test_rejects_what_the_recipe_does_not_allow(self):
        text = Path(self.tmp) / "not-a-dll.txt"
        text.write_text("MZ but nothing else")
        cases = {
            "imports opengl32": ({"gles": self.variants["opengl32"]}, "libGLESv2.dll imports OPENGL32.dll"),
            "delay-loads opengl32": ({"gles": self.variants["delayed opengl32"]}, "libGLESv2.dll imports opengl32.dll"),
            "imports an unlisted DLL": ({"gles": self.variants["gdi32"]}, "libGLESv2.dll imports GDI32.dll, which"),
            "lacks an export": ({"egl": self.variants["no eglGetProcAddress"]}, "does not export eglGetProcAddress"),
            "is an x86 DLL": ({"egl": self.variants["x86"]}, "libEGL.dll is a x86 DLL"),
            "is missing": ({"egl": "absent"}, "libEGL.dll is not a readable PE image"),
            "is not a PE image": ({"gles": text}, "libGLESv2.dll is not a readable PE image"),
        }
        for name, (files, expected) in cases.items():
            with self.subTest(name):
                _, failures = self.gate(self.stage(**files))
                self.assertTrue(any(expected in failure for failure in failures), failures)


if __name__ == "__main__":
    unittest.main()
