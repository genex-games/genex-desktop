"""The interior kit's textures, made from CC0 scans (all Poly Haven, CC0-1.0) in Blender's Python:

- `trim_color|normal|orm.jpg` (1024 x 512, one metre across, tiling along u): each strip of
  `interior_kit.STRIPS` a painted profile (its normal from the profile's height), paint worn off its
  arrises where the rust scan's chipping says, and dirt in its hollows.
- `props_color|normal|orm.jpg` (1024 x 1024 at 512 texels per metre): the regions of
  `interior_kit.REGIONS`, each a crop of a scan (or a scan repainted), never noise.
- `decals/*.png` (and their normals as JPEG): peeling paint along an edge and in a patch, a crack, a leak and the grime along
  a floor: flakes torn along a cell pattern warped by `peeling_painted_wall`, its own crack lines
  across the paint that is left.

`make(scans, out, strips, regions)` reads the scans from a folder laid out as a game's `assets/` (the
`cc0__fetch {source: "polyhaven", id, resolution: "1k"}` deliveries of `SCANS`) and writes into `out`.
"""

import glob
import os

import bpy
import numpy as np

# The scans used, by Poly Haven id, and the maps read from each.
SCANS = {
    "wood_table_worn": ("diff", "nor_gl"),
    "green_metal_rust": ("diff", "nor_gl", "arm"),
    "rusty_metal_02": ("diff", "nor_gl"),
    "concrete_wall_003": ("diff", "nor_gl", "arm"),
    "painted_plaster_wall": ("diff", "nor_gl", "arm"),
    "peeling_painted_wall": ("diff", "nor_gl"),
}
TRIM_W, TRIM_H = 1024, 512
ATLAS = 1024
# JPEG quality: colour maps take more loss than the normal and ORM maps (a PNG ignores it).
COLOUR_QUALITY, DATA_QUALITY = 82, 78
# How deep a profile's full height is, in texels of the trim sheet (1 texel ~ 1 mm): its slope.
PROFILE_DEPTH = 9.0


def load(scans, scan, kind):
    """A scan's map as rows from the top, RGB floats as stored (no colour transform)."""
    found = glob.glob(os.path.join(scans, "**", f"{scan}_{kind}_1k.jpg"), recursive=True)
    if not found:
        raise FileNotFoundError(f"{scan}_{kind}_1k.jpg under {scans}: cc0__fetch it first")
    image = bpy.data.images.load(found[0])
    image.colorspace_settings.name = "Non-Color"
    w, h = image.size
    pixels = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(h, w, 4)[::-1, :, :3].copy()


def save(array, path, quality):
    """Rows from the top, RGB or RGBA floats 0..1, written as stored: a JPEG for an opaque map, a
    PNG for one with alpha (the native renderer decodes only those two)."""
    h, w = array.shape[:2]
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., : array.shape[2]] = np.clip(array, 0.0, 1.0)
    image = bpy.data.images.new(os.path.basename(path), w, h, alpha=array.shape[2] == 4)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(rgba[::-1].ravel())
    image.filepath_raw, image.file_format = path, "PNG" if path.endswith(".png") else "JPEG"
    image.save(quality=quality)
    bpy.data.images.remove(image)


def resize(array, h, w):
    """Bilinear resample to h x w, wrapping (the scans tile)."""
    sh, sw = array.shape[:2]
    ys, xs = (np.arange(h) + 0.5) * sh / h - 0.5, (np.arange(w) + 0.5) * sw / w - 0.5
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    y0, y1, x0, x1 = y0 % sh, (y0 + 1) % sh, x0 % sw, (x0 + 1) % sw
    top = array[y0][:, x0] * (1 - fx) + array[y0][:, x1] * fx
    bottom = array[y1][:, x0] * (1 - fx) + array[y1][:, x1] * fx
    return top * (1 - fy) + bottom * fy


def blur(array, radius, axis=None):
    """A wrapping box blur of `radius` texels, over both axes or one."""
    out = array
    for ax in (0, 1) if axis is None else (axis,):
        acc = np.zeros_like(out)
        for shift in range(-radius, radius + 1):
            acc += np.roll(out, shift, axis=ax)
        out = acc / (2 * radius + 1)
    return out


def luma(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def rust_mask(rusty):
    """Where the rusty scan's paint has gone: its orange, saturated spots (0..1)."""
    saturation = rusty.max(axis=-1) - rusty.min(axis=-1)
    return np.clip((saturation - 0.12) * 5.0, 0.0, 1.0)


def normal_from_height(height, strength):
    """A GL tangent-space normal map (green up the image) from a height field."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5 * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5 * strength
    n = np.stack([-dx, dy, np.ones_like(height)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def mix_normals(base, detail, amount):
    """`detail`'s tilt laid over `base` (both encoded maps), `amount` of it."""
    b, d = base * 2 - 1, detail * 2 - 1
    n = np.stack([b[..., 0] + d[..., 0] * amount, b[..., 1] + d[..., 1] * amount, b[..., 2]], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def rgb(*value):
    return np.array(value, np.float32)


# ── The trim sheet ──


def profile(kind, t):
    """A strip's height across it (t from 0 at its top row to 1 at its bottom), 0..1."""
    if kind == "skirting":
        top = np.sqrt(np.clip(1 - ((0.14 - t) / 0.14) ** 2, 0, 1))
        return np.where(t < 0.14, top, np.where((t > 0.22) & (t < 0.26), 0.55, 1.0))
    if kind == "rail":
        return np.sqrt(np.clip(1 - (2 * t - 1) ** 2, 0, 1)) * np.where(np.abs(t - 0.5) < 0.04, 0.85, 1.0)
    if kind == "architrave":
        bead = np.sqrt(np.clip(1 - ((0.06 - t) / 0.06) ** 2, 0, 1))
        return np.where(t < 0.06, bead, np.where(t < 0.36, 1.0, np.where(t < 0.4, 0.62, 0.7 - 0.12 * (t - 0.4))))
    if kind in ("frame", "bar"):
        edge = 0.1 if kind == "frame" else 0.18
        return np.clip(np.minimum(t, 1 - t) / edge, 0, 1)
    if kind == "sash":
        return np.sqrt(np.clip(1 - (np.clip(0.28 - np.minimum(t, 1 - t), 0, 1) / 0.28) ** 2, 0, 1))
    return np.ones_like(t)


# Each strip's paint, what is under it, how far it is worn and its paint's roughness.
STRIP_LOOKS = {
    "skirting": (rgb(0.24, 0.12, 0.08), "wood", 0.55, 0.45),
    "rail": (rgb(0.12, 0.2, 0.25), "wood", 0.5, 0.4),
    "architrave": (rgb(0.4, 0.16, 0.1), "wood", 0.45, 0.42),
    "frame": (rgb(0.74, 0.73, 0.68), "wood", 0.8, 0.5),
    "sash": (rgb(0.74, 0.73, 0.68), "wood", 0.9, 0.5),
    "bar": (rgb(0.16, 0.18, 0.17), "rust", 0.7, 0.55),
    "edge": (rgb(0.3, 0.3, 0.28), "wood", 0.3, 0.5),
}


def trim_sheet(scan, strips, out):
    wood = resize(scan("wood_table_worn", "diff"), TRIM_W, TRIM_W)[:TRIM_H]
    wood_n = resize(scan("wood_table_worn", "nor_gl"), TRIM_W, TRIM_W)[:TRIM_H]
    rusty = resize(scan("rusty_metal_02", "diff"), TRIM_H, TRIM_W)
    chips = rust_mask(rusty)
    rust = rusty * rgb(0.75, 0.55, 0.4)
    colour = np.zeros((TRIM_H, TRIM_W, 3), np.float32)
    height = np.zeros((TRIM_H, TRIM_W), np.float32)
    rough = np.zeros((TRIM_H, TRIM_W), np.float32)
    for name, (top, bottom) in strips.items():
        paint, under, wear, gloss = STRIP_LOOKS[name]
        rows = slice(top, bottom)
        t = (np.arange(bottom - top) + 0.5) / (bottom - top)
        h = profile(name, t)[:, None] * np.ones((1, TRIM_W))
        slope = np.abs(np.gradient(h, axis=0)) * PROFILE_DEPTH
        # Paint goes where the profile turns (an arris) and where the scan's chipping says, more on
        # the turns; dirt sits in the hollows.
        worn = np.clip((chips[rows] * (0.4 + slope * 2.5) - (1 - wear)) * 3.0, 0, 1)
        substrate = (wood if under == "wood" else rust)[rows]
        grain = 0.88 + 0.24 * (luma(wood[rows]) - luma(wood[rows]).mean())
        painted = paint * grain[..., None]
        hollow = np.clip(blur(h, 3, axis=0) - h, 0, 1)
        colour[rows] = (painted * (1 - worn[..., None]) + substrate * worn[..., None]) * (1 - hollow[..., None] * 2.5)
        height[rows] = h - worn * 0.08
        rough[rows] = gloss + worn * 0.3 + hollow
    normal = mix_normals(normal_from_height(height * PROFILE_DEPTH, 1.0), wood_n, 0.25)
    occlusion = np.clip(1 - np.clip(blur(height, 4, axis=0) - height, 0, 1) * 4, 0, 1)
    orm = np.stack([occlusion, np.clip(rough, 0, 1), np.zeros_like(rough)], -1)
    save(colour, os.path.join(out, "trim_color.jpg"), COLOUR_QUALITY)
    save(normal, os.path.join(out, "trim_normal.jpg"), DATA_QUALITY)
    save(orm, os.path.join(out, "trim_orm.jpg"), DATA_QUALITY)


# ── The props atlas ──


def region_fill(target, region, source):
    x0, y0, x1, y1 = region
    target[y0:y1, x0:x1] = resize(source, y1 - y0, x1 - x0) if source.shape[:2] != (y1 - y0, x1 - x0) else source


def props_atlas(scan, regions, out):
    flat_n = np.full((ATLAS, ATLAS, 3), (0.5, 0.5, 1.0), np.float32)
    colour = np.zeros((ATLAS, ATLAS, 3), np.float32)
    normal = flat_n.copy()
    orm = np.zeros((ATLAS, ATLAS, 3), np.float32)
    orm[..., 0] = 1.0

    def fill(name, rgb_map, normal_map, rough_map, metal=0.0, ao_map=None):
        region_fill(colour, regions[name], rgb_map)
        if normal_map is not None:
            region_fill(normal, regions[name], normal_map)
        x0, y0, x1, y1 = regions[name]
        r = rough_map if np.ndim(rough_map) else np.full(rgb_map.shape[:2], rough_map, np.float32)
        region_fill(orm[..., 1:2], regions[name], r[..., None])
        orm[y0:y1, x0:x1, 2] = metal
        if ao_map is not None:
            region_fill(orm[..., 0:1], regions[name], ao_map[..., None])

    wood, wood_n = scan("wood_table_worn", "diff"), scan("wood_table_worn", "nor_gl")
    steel, steel_n, steel_arm = scan("green_metal_rust", "diff"), scan("green_metal_rust", "nor_gl"), scan("green_metal_rust", "arm")
    rusty, rusty_n = scan("rusty_metal_02", "diff"), scan("rusty_metal_02", "nor_gl")
    concrete, concrete_n, concrete_arm = scan("concrete_wall_003", "diff"), scan("concrete_wall_003", "nor_gl"), scan("concrete_wall_003", "arm")
    plaster, plaster_n, plaster_arm = scan("painted_plaster_wall", "diff"), scan("painted_plaster_wall", "nor_gl"), scan("painted_plaster_wall", "arm")
    chips = rust_mask(rusty)
    grime = luma(concrete)

    # Varnished school plywood: the worn table scan, yellower and glossier.
    fill("wood", wood * rgb(1.15, 1.02, 0.78), wood_n, 0.55 + 0.3 * (1 - luma(wood)))
    # Green enamelled steel (desk and chair frames, radiators): the scan as it is, a quarter of it.
    fill("steel", steel[:512], steel_n[:512], steel_arm[:512, :, 1], ao_map=steel_arm[:512, :, 0])
    # Lockers: a cold institutional blue-grey paint over the rusty scan's grain, rust only where it chipped.
    locker_rust = np.clip((chips - 0.6) * 3, 0, 1)[..., None]
    locker = rgb(0.42, 0.5, 0.56) * (0.8 + 0.4 * luma(rusty))[..., None]
    fill("locker", locker * (1 - locker_rust) + rusty * rgb(0.7, 0.5, 0.38) * locker_rust, rusty_n, 0.45 + locker_rust[..., 0] * 0.4)
    # Bare rust (a bench's iron ends): the rusty scan darkened to old iron.
    fill("rust", rusty[:512, :512] * rgb(0.55, 0.38, 0.28), rusty_n[:512, :512], 0.85)
    # Slate: near black, chalk wiped across it in arcs (the concrete's grime smeared sideways).
    smear = blur(resize(grime[..., None], 256, 512)[..., 0], 12, axis=1)
    chalk = np.clip((smear - smear.mean()) * 4.0 + 0.15, 0, 1) * 0.35
    fill("slate", rgb(0.045, 0.06, 0.055) + chalk[..., None] * rgb(0.6, 0.62, 0.6), mix_normals(np.full((256, 512, 3), (0.5, 0.5, 1.0), np.float32), resize(concrete_n, 256, 512), 0.2), 0.88 - chalk * 0.2)
    fill("concrete", concrete[:512, :512], concrete_n[:512, :512], concrete_arm[:512, :512, 1], ao_map=concrete_arm[:512, :512, 0])
    fill("plaster", plaster[:512, :512], plaster_n[:512, :512], plaster_arm[:512, :512, 1], ao_map=plaster_arm[:512, :512, 0])
    # Paper: off-white, foxed where the concrete is dark, a crease or two.
    fox = resize(grime[..., None], 256, 256)[..., 0]
    paper = rgb(0.86, 0.85, 0.8) * (0.9 + 0.12 * (fox - fox.mean()))[..., None]
    fill("paper", paper, None, 0.9)
    # Doors and pedestals: brown-red paint over the plywood, worn through where the chips are.
    worn = np.clip((resize(chips[..., None], 1024, 1024)[..., 0] - 0.55) * 4, 0, 1)
    door = rgb(0.4, 0.16, 0.1) * (0.85 + 0.3 * luma(wood))[..., None]
    fill("door", door * (1 - worn[..., None]) + wood * worn[..., None], wood_n, 0.45 + worn * 0.3)
    # White enamel (light fittings, number plates) chipped to rust; black rubber and bakelite.
    enamel_chips = np.clip((chips[:256, :512] - 0.75) * 4, 0, 1)
    enamel = rgb(0.84, 0.84, 0.8) * (1 - enamel_chips[..., None]) + rusty[:256, :512] * rgb(0.6, 0.42, 0.3) * enamel_chips[..., None]
    fill("enamel", enamel, rusty_n[:256, :512], 0.3 + enamel_chips * 0.5)
    fill("rubber", rgb(0.04, 0.04, 0.04) + resize(grime[..., None], 128, 256) * 0.04, None, 0.8)
    save(colour, os.path.join(out, "props_color.jpg"), COLOUR_QUALITY)
    save(normal, os.path.join(out, "props_normal.jpg"), DATA_QUALITY)
    save(orm, os.path.join(out, "props_orm.jpg"), DATA_QUALITY)


# ── Decals ──


def crack_network(peeling):
    """The peeling scan's cracks (thin dark lines) as a mask, 0..1."""
    lum = luma(peeling)
    return np.clip(((blur(lum, 5) - lum) - 0.035) * 25.0, 0, 1)


def flakes(height, width, size, warp, rng):
    """Flake cells: each texel takes the nearest of a jittered grid of points `size` apart, the
    texels displaced by the scan `warp`'s shading first, so the cells' edges wander like torn paint.
    Answers each texel's cell, the cells' edge texels and each cell's point (y, x)."""
    rows, cols = height // size + 3, width // size + 3
    py = (np.arange(rows)[:, None] + rng.random((rows, cols)) - 1) * size
    px = (np.arange(cols)[None, :] + rng.random((rows, cols)) - 1) * size
    shade = blur(luma(warp), 4)
    shade = (shade - shade.mean()) / max(shade.std(), 1e-6)
    y = np.arange(height)[:, None] + shade * size * 0.35
    x = np.arange(width)[None, :] + np.roll(shade, size, 0) * size * 0.35
    cy, cx = np.floor(y / size).astype(int) + 1, np.floor(x / size).astype(int) + 1
    best, second = np.full(y.shape, np.inf), np.full(y.shape, np.inf)
    ident = np.zeros(y.shape, int)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            j, i = np.clip(cy + dy, 0, rows - 1), np.clip(cx + dx, 0, cols - 1)
            d = np.hypot(y - py[j, i], x - px[j, i])
            closer = d < best
            second = np.where(closer, best, np.minimum(second, d))
            ident = np.where(closer, j * cols + i, ident)
            best = np.where(closer, d, best)
    return ident, (second - best) < 1.2, (py.ravel(), px.ravel())


def peel(scan, size, chance, seed):
    """Peeled paint: the plaster under it where flakes are gone (kept by `chance(y, x)` of each
    flake's point), the scan's own cracks across what is left, a dark lip round each hole, and
    the normal of a hole sunk below the paint."""
    h, w = size
    rng = np.random.default_rng(seed)
    peeling = scan("peeling_painted_wall", "diff")
    tile = np.tile(peeling, (h // 1024 + 1, w // 1024 + 1, 1))[:h, :w]
    ident, edge, (py, px) = flakes(h, w, 26, tile, rng)
    picked = rng.random(len(py)) < chance(py, px)
    hole = picked[ident] & ~edge
    # Close the edges between two lost flakes, so a hole is one hole.
    near = hole | np.roll(hole, 1, 0) | np.roll(hole, -1, 0) | np.roll(hole, 1, 1) | np.roll(hole, -1, 1)
    hole = (hole | (edge & near & picked[ident])).astype(np.float32)
    concrete = resize(scan("concrete_wall_003", "diff"), h, w)
    # Old lime plaster: the concrete's grain, its colour drawn to a cold off-white.
    grain = luma(concrete)
    plaster = (0.78 + (grain - grain.mean())[..., None] * 0.6) * rgb(0.95, 0.94, 0.9)
    near_hole = np.clip(blur(hole, 20) * 3.0, 0, 1)
    cracks = crack_network(tile) * (1 - hole) * near_hole
    lip = np.clip(blur(hole, 2) * 2.0 - hole * 2.0, 0, 1)
    colour = plaster * hole[..., None] + rgb(0.1, 0.09, 0.08) * (1 - hole[..., None])
    alpha = np.clip(hole + lip * 0.45 + cracks * 0.6, 0, 1)
    normal = normal_from_height(blur(1 - hole, 1) * 3.0 - cracks, 1.0)
    return np.concatenate([colour, alpha[..., None]], -1), normal


def decals(scan, out):
    folder = os.path.join(out, "decals")
    os.makedirs(folder, exist_ok=True)
    # Flakes along an edge (the dado line, a sill, a skirting's top): dense at the decal's top row.
    edge, edge_n = peel(scan, (256, 1024), lambda y, x: 0.9 * np.exp(-y / 55.0), 3)
    save(edge, os.path.join(folder, "peel_edge.png"), COLOUR_QUALITY)
    save(edge_n, os.path.join(folder, "peel_edge_normal.jpg"), DATA_QUALITY)
    # A patch: dense in the middle, ragged at its rim.
    centre = lambda y, x: np.clip(1.15 - np.hypot(y - 256, x - 256) / 210.0, 0, 0.95)  # noqa: E731
    patch, patch_n = peel(scan, (512, 512), centre, 5)
    save(patch, os.path.join(folder, "peel_patch.png"), COLOUR_QUALITY)
    save(patch_n, os.path.join(folder, "peel_patch_normal.jpg"), DATA_QUALITY)
    concrete = scan("concrete_wall_003", "diff")
    columns = blur(resize(luma(concrete)[..., None], 1, 256)[0, :, 0][None, :], 3, axis=1)[0]
    # A leak: streaks run down from the top, each its own length, ending in a darker tide line.
    y = np.arange(512)[:, None] / 512.0
    length = 0.35 + 0.6 * (columns - columns.min()) / max(np.ptp(columns), 1e-6)
    run = np.clip(1 - y / length[None, :], 0, 1)
    tide = np.exp(-(((y - length[None, :]) / 0.02) ** 2)) * 0.6
    streaks = resize(luma(concrete)[..., None], 64, 256)[..., 0]
    streaks = resize(((streaks - streaks.mean()) / max(streaks.std(), 1e-6))[..., None], 512, 256)[..., 0]
    stain = np.clip(run ** 0.6 * (0.45 + 0.15 * streaks) + tide, 0, 0.8) * np.clip(1 - np.abs(np.linspace(-1, 1, 256))[None, :] ** 3, 0, 1)
    leak = np.concatenate([np.broadcast_to(rgb(0.3, 0.24, 0.15), (512, 256, 3)), stain[..., None]], -1)
    save(leak, os.path.join(folder, "leak.png"), COLOUR_QUALITY)
    # Grime along a floor: heaviest at the bottom row, rising in uneven streaks.
    rise = blur(resize(luma(concrete)[..., None], 1, 1024)[0, :, 0][None, :], 6, axis=1)[0]
    reach = 0.3 + 0.6 * (rise - rise.min()) / max(np.ptp(rise), 1e-6)
    up = 1 - np.arange(128)[:, None] / 128.0
    band = np.clip(1 - up / reach[None, :], 0, 1) ** 1.5 * 0.75
    grime = np.concatenate([np.broadcast_to(rgb(0.1, 0.085, 0.07), (128, 1024, 3)), band[..., None]], -1)
    save(grime, os.path.join(folder, "grime_base.png"), COLOUR_QUALITY)
    # A crack: the scan's own crack lines where a blob reaches, dark, with a groove in its normal.
    lines = crack_network(scan("peeling_painted_wall", "diff")[256:768, 256:768])
    reach = np.clip(1.2 - np.hypot(*np.meshgrid(np.arange(512) - 256, np.arange(512) - 256)) / 220.0, 0, 1)
    crack = np.clip(blur(lines, 1) * 2.0, 0, 1) * reach
    save(np.concatenate([np.broadcast_to(rgb(0.07, 0.065, 0.06), (512, 512, 3)), crack[..., None]], -1), os.path.join(folder, "crack.png"), COLOUR_QUALITY)


def make(scans, out, strips, regions):
    """Every sheet and decal from the scans under `scans`, into `out`, for the kit's trim `strips`
    and atlas `regions`."""
    cache = {}

    def scan(name, kind):
        if (name, kind) not in cache:
            cache[(name, kind)] = load(scans, name, kind)
        return cache[(name, kind)]

    trim_sheet(scan, strips, out)
    props_atlas(scan, regions, out)
    decals(scan, out)
    print("SHEETS into", out)
