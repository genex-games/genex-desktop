#!/usr/bin/env python3
"""Reads the facts build_angle.py gates a Windows DLL on straight from its PE headers.

No toolchain is needed (the hosted Windows runner has no llvm-readobj in ANGLE's checkout and
dumpbin needs a Visual Studio environment), so the gate runs the same on every OS:

  python3 native/angle/pe_imports.py libGLESv2.dll

prints {"machine", "dll", "imports", "delayImports", "exports"} as JSON. Every offset read from
the file is bounds-checked; a file that is not a well-formed PE raises PeError.

Tests: python3 -m unittest discover -s native/angle -p "test_*.py"
"""

import json
import struct
import sys

MACHINES = {0x014C: "x86", 0x8664: "x64", 0xAA64: "arm64"}
PE32_MAGIC = 0x10B
PE32_PLUS_MAGIC = 0x20B
IMAGE_FILE_DLL = 0x2000
EXPORT_DIRECTORY, IMPORT_DIRECTORY, DELAY_IMPORT_DIRECTORY = 0, 1, 13
IMPORT_DESCRIPTOR_SIZE = 20
DELAY_DESCRIPTOR_SIZE = 32
SECTION_HEADER_SIZE = 40
# Delay descriptors whose attributes lack this bit hold virtual addresses instead of RVAs.
DELAY_ATTRIBUTE_RVA = 0x1
MAX_DESCRIPTORS = 4096
MAX_EXPORT_NAMES = 1 << 16
MAX_NAME_BYTES = 512


class PeError(ValueError):
    """The file is not a PE image this reader can vouch for."""


class _Image:
    def __init__(self, data):
        self.data = data
        if self.read(0, 2) != b"MZ":
            raise PeError("no MZ header")
        pe = self.u32(0x3C)
        if self.read(pe, 4) != b"PE\0\0":
            raise PeError("no PE signature")
        machine, sections, _, _, _, optional_size, characteristics = struct.unpack_from(
            "<HHIIIHH", self.read(pe + 4, 20)
        )
        optional = pe + 24
        magic = self.u16(optional)
        if magic == PE32_PLUS_MAGIC:
            self.image_base = struct.unpack_from("<Q", self.read(optional + 24, 8))[0]
            directory_count, directories = self.u32(optional + 108), optional + 112
        elif magic == PE32_MAGIC:
            self.image_base = self.u32(optional + 28)
            directory_count, directories = self.u32(optional + 92), optional + 96
        else:
            raise PeError(f"unknown optional header magic {magic:#x}")
        self.machine = MACHINES.get(machine, f"{machine:#06x}")
        self.is_dll = bool(characteristics & IMAGE_FILE_DLL)
        self.directories = [
            struct.unpack_from("<II", self.read(directories + 8 * index, 8)) for index in range(min(directory_count, 16))
        ]
        table = optional + optional_size
        self.sections = [
            struct.unpack_from("<IIII", self.read(table + SECTION_HEADER_SIZE * index + 8, 16))
            for index in range(sections)
        ]

    def read(self, offset, size):
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise PeError(f"read of {size} bytes at {offset:#x} is outside the {len(self.data)}-byte file")
        return self.data[offset : offset + size]

    def u16(self, offset):
        return struct.unpack_from("<H", self.read(offset, 2))[0]

    def u32(self, offset):
        return struct.unpack_from("<I", self.read(offset, 4))[0]

    def offset(self, rva):
        """The file offset of an RVA, from the section that maps it."""
        for virtual_size, virtual_address, raw_size, raw_pointer in self.sections:
            if virtual_address <= rva < virtual_address + max(virtual_size, raw_size):
                if rva - virtual_address >= raw_size:
                    raise PeError(f"RVA {rva:#x} is in uninitialised section data")
                return raw_pointer + rva - virtual_address
        raise PeError(f"RVA {rva:#x} is in no section")

    def string(self, rva):
        start = self.offset(rva)
        end = self.data.find(b"\0", start, start + MAX_NAME_BYTES)
        if end < 0:
            raise PeError(f"unterminated name at RVA {rva:#x}")
        return self.data[start:end].decode("ascii", errors="replace")

    def directory(self, index):
        return self.directories[index] if index < len(self.directories) else (0, 0)


def _imports(image):
    rva, _ = image.directory(IMPORT_DIRECTORY)
    names = []
    if not rva:
        return names
    base = image.offset(rva)
    for index in range(MAX_DESCRIPTORS):
        descriptor = struct.unpack_from("<IIIII", image.read(base + index * IMPORT_DESCRIPTOR_SIZE, IMPORT_DESCRIPTOR_SIZE))
        if not any(descriptor):
            return names
        names.append(image.string(descriptor[3]))
    raise PeError(f"more than {MAX_DESCRIPTORS} import descriptors")


def _delay_imports(image):
    rva, _ = image.directory(DELAY_IMPORT_DIRECTORY)
    names = []
    if not rva:
        return names
    base = image.offset(rva)
    for index in range(MAX_DESCRIPTORS):
        attributes, name = struct.unpack_from("<II", image.read(base + index * DELAY_DESCRIPTOR_SIZE, 8))
        if not name:
            return names
        names.append(image.string(name if attributes & DELAY_ATTRIBUTE_RVA else name - image.image_base))
    raise PeError(f"more than {MAX_DESCRIPTORS} delay-import descriptors")


def _exports(image):
    rva, _ = image.directory(EXPORT_DIRECTORY)
    if not rva:
        return []
    count, names_rva = struct.unpack_from("<I4xI", image.read(image.offset(rva) + 24, 12))
    if count > MAX_EXPORT_NAMES:
        raise PeError(f"{count} export names")
    table = image.offset(names_rva) if count else 0
    return [image.string(image.u32(table + 4 * index)) for index in range(count)]


def pe_facts(data):
    """The machine, DLL flag, imported and delay-imported DLL names and exported names of a PE image."""
    image = _Image(bytes(data))
    return {
        "machine": image.machine,
        "dll": image.is_dll,
        "imports": _imports(image),
        "delayImports": _delay_imports(image),
        "exports": _exports(image),
    }


def main(paths):
    for path in paths:
        with open(path, "rb") as handle:
            facts = pe_facts(handle.read())
        facts["exports"] = len(facts["exports"])
        print(json.dumps({"file": path, **facts}))


if __name__ == "__main__":
    main(sys.argv[1:])
