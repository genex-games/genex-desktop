"""The materials Unreal failed to compile, read from lines of its editor log. Unreal logs each failure
as a warning and draws the material with its default one in game; the reasons follow on lines that
start with a tab:

    LogMaterial: Warning: [AssetLog] /Game/Env/M_Water.M_Water: Failed to compile Material for platform
    SF_METAL_SM6, Default Material will be used in game.
    \tSingleLayerWater materials requires the use of SingleLayerWaterMaterial output node.

An instance's line names its base ("Failed to compile Material Instance with Base M_Surface"), and a
material may be named by its package file (<project>/Content/Env/M_Water.uasset). Each material is
answered once, by its /Game/ path, with its distinct reasons. Pure Python: it reads text only.
"""

import re

FAILED = re.compile(r'(?:\[AssetLog\] )?(?P<asset>\S+): Failed to compile (?P<kind>Material Instance|Material)'
                    r'(?: with Base (?P<base>\S+))? for platform (?P<platform>\w+)')
CONTENT_FOLDER = '/Content/'
PACKAGE_EXTENSION = '.uasset'
MATERIALS_CAP = 12
REASONS_CAP = 4
REASON_CHARS = 300
INSTANCE = 'Material Instance'


def game_path(name: str) -> str:
    """/Game/Env/M_Water for /Game/Env/M_Water.M_Water or <project>/Content/Env/M_Water.uasset."""
    if name.endswith(PACKAGE_EXTENSION) and CONTENT_FOLDER in name:
        return '/Game/' + name.rsplit(CONTENT_FOLDER, 1)[1][:-len(PACKAGE_EXTENSION)]
    return name.split('.', 1)[0]


def _reasons(lines: list, start: int) -> list:
    """The indented reason lines right after line `start`."""
    found = []
    for line in lines[start + 1:]:
        if not line.startswith(('\t', ' ')) or not line.strip():
            break
        found.append(line.strip()[:REASON_CHARS])
    return found


def material_failures(text: str) -> list:
    """[{material, instanceOf?, platform, reasons}] for each material the log text says failed to compile."""
    lines = text.splitlines()
    found: dict = {}
    for index, line in enumerate(lines):
        match = FAILED.search(line)
        if match is None:
            continue
        material = game_path(match['asset'])
        entry = found.get(material)
        if entry is None:
            if len(found) >= MATERIALS_CAP:
                continue
            entry = found[material] = {'material': material, 'platform': match['platform'], 'reasons': []}
            if match['kind'] == INSTANCE and match['base']:
                entry['instanceOf'] = match['base']
        for reason in _reasons(lines, index):
            if reason not in entry['reasons'] and len(entry['reasons']) < REASONS_CAP:
                entry['reasons'].append(reason)
    return list(found.values())


def failure_message(failures: list) -> str:
    """One sentence naming each failed material and its first reason."""
    named = '; '.join(f"{f['material']} ({f['reasons'][0] if f['reasons'] else 'no reason given'})" for f in failures)
    return (f'Unreal could not compile {len(failures)} material(s) while the script ran, so they draw as its default '
            f'material in game: {named}. Fix them and run the script again.')
