"""Download the CC0 Poly Haven assets the realism test scene uses (standard library only).

Usage: python3 -I fetch_assets.py <assets-dir>
"""
import json
import os
import sys
import urllib.request

API = "https://api.polyhaven.com/files/"
RES = "1k"
TEXTURES = [
    "red_plaster_weathered",
    "blue_plaster_weathered",
    "large_sandstone_blocks",
    "cobblestone_floor_08",
    "wood_shutter",
    "clay_roof_tiles_02",
]
TEXTURE_MAPS = {"Diffuse": "diff", "nor_gl": "nor_gl", "Rough": "rough"}
MODELS = [
    "wooden_crate_01",
    "wooden_crate_02",
    "wooden_barrels_01",
    "planter_pot_clay",
    "ceramic_vase_01",
    "ceramic_vase_03",
    "large_castle_door",
    "wooden_lantern_01",
    "garden_hose_wall_mounted_01",
    "utility_box_01",
    "painted_wooden_bench",
    "wooden_bucket_01",
    "water_manhole_cover",
    "potted_plant_04",
]
HDRI = "kloofendal_48d_partly_cloudy_puresky"


def get(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "genex-realism-test/1.0"})
    with urllib.request.urlopen(req, timeout=120) as response, open(dest + ".part", "wb") as out:
        out.write(response.read())
    os.replace(dest + ".part", dest)


def files(asset):
    req = urllib.request.Request(API + asset, headers={"User-Agent": "genex-realism-test/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


def main(root):
    for name in TEXTURES:
        info = files(name)
        for key, short in TEXTURE_MAPS.items():
            entry = info[key][RES]["jpg"]
            get(entry["url"], os.path.join(root, "textures", name, f"{name}_{short}.jpg"))
        print("texture", name)
    for name in MODELS:
        gltf = files(name)["gltf"][RES]["gltf"]
        folder = os.path.join(root, "models", name)
        get(gltf["url"], os.path.join(folder, f"{name}.gltf"))
        for rel, entry in gltf.get("include", {}).items():
            get(entry["url"], os.path.join(folder, rel))
        print("model", name)
    hdri = files(HDRI)["hdri"][RES]["hdr"]
    get(hdri["url"], os.path.join(root, "hdri", f"{HDRI}.hdr"))
    print("hdri", HDRI)


if __name__ == "__main__":
    main(sys.argv[1])
