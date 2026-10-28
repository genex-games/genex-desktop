"""The interior kit's textures, made from 2k CC0 scans (all Poly Haven, CC0-1.0) and images generated
with Genex (`generated.json`) in Blender's Python:

- `trim_color|normal|orm.jpg` (2048 x 1024, one metre across, tiling along u): each strip of
  `interior_kit.STRIPS` a painted profile (its normal from the profile's height), paint worn off its
  arrises where the rust scan's chipping says, and dirt in its hollows.
- `props_color|normal|orm.jpg` (2048 x 2048 at 1024 texels per metre): the regions of
  `interior_kit.REGIONS`, each a crop of a scan (or a scan repainted), never noise.
- `decals/*.png` (and their normals as JPEG): a crack from `peeling_painted_wall`'s own crack lines,
  and the generated photographs keyed to decals: paint peeled along an edge and in a patch, a leak, a
  ceiling stain, the grime along a floor, a lesson in chalk and four school posters.

`make(scans, out, strips, regions, generated)` reads the scans from a folder laid out as a game's
`assets/` (the `cc0__fetch {source: "polyhaven", id, resolution: "2k"}` deliveries of `SCANS`) and
the generated images from `generated` (`<name>.png`, downloaded from `generated.json`'s URLs), and
writes into `out`. `interior_kit.STRIPS` and `REGIONS` are in 1k texels: each is scaled by `K`.
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
    "peeling_painted_wall": ("diff",),
}
# The scans' resolution, and the sheets' texels per 1k texel of `interior_kit`'s strips and regions.
RESOLUTION, K = "2k", 2
TRIM_W, TRIM_H = 1024 * K, 512 * K
ATLAS = 1024 * K
# JPEG quality: colour maps take more loss than the normal and ORM maps (a PNG ignores it).
COLOUR_QUALITY, DATA_QUALITY = 82, 78
# How deep a profile's full height is, in texels of the trim sheet (1 texel ~ 0.5 mm): its slope.
PROFILE_DEPTH = 9.0 * K


def load(scans, scan, kind):
    """A scan's map as rows from the top, RGB floats as stored (no colour transform)."""
    found = glob.glob(os.path.join(scans, "**", f"{scan}_{kind}_{RESOLUTION}.jpg"), recursive=True)
    if not found:
        raise FileNotFoundError(f"{scan}_{kind}_{RESOLUTION}.jpg under {scans}: cc0__fetch it first")
    return read(found[0])[..., :3]


def read(path):
    """An image file as rows from the top, RGBA floats as stored."""
    image = bpy.data.images.load(path)
    image.colorspace_settings.name = "Non-Color"
    w, h = image.size
    pixels = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(h, w, 4)[::-1].copy()


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
        hollow = np.clip(blur(h, 3 * K, axis=0) - h, 0, 1)
        colour[rows] = (painted * (1 - worn[..., None]) + substrate * worn[..., None]) * (1 - hollow[..., None] * 2.5)
        height[rows] = h - worn * 0.08
        rough[rows] = gloss + worn * 0.3 + hollow
    normal = mix_normals(normal_from_height(height * PROFILE_DEPTH, 1.0), wood_n, 0.25)
    occlusion = np.clip(1 - np.clip(blur(height, 4 * K, axis=0) - height, 0, 1) * 4, 0, 1)
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
    # Green enamelled steel (desk and chair frames, radiators): the scan as it is, half of it.
    half = 512 * K
    fill("steel", steel[:half], steel_n[:half], steel_arm[:half, :, 1], ao_map=steel_arm[:half, :, 0])
    # Lockers: a cold institutional blue-grey paint over the rusty scan's grain, rust only where it chipped.
    locker_rust = np.clip((chips - 0.6) * 3, 0, 1)[..., None]
    locker = rgb(0.42, 0.5, 0.56) * (0.8 + 0.4 * luma(rusty))[..., None]
    fill("locker", locker * (1 - locker_rust) + rusty * rgb(0.7, 0.5, 0.38) * locker_rust, rusty_n, 0.45 + locker_rust[..., 0] * 0.4)
    # Bare rust (a bench's iron ends): the rusty scan darkened to old iron.
    fill("rust", rusty[:half, :half] * rgb(0.55, 0.38, 0.28), rusty_n[:half, :half], 0.85)
    # Slate: near black, chalk wiped across it in arcs (the concrete's grime smeared sideways).
    smear = blur(resize(grime[..., None], 256 * K, half)[..., 0], 12 * K, axis=1)
    chalk = np.clip((smear - smear.mean()) * 4.0 + 0.15, 0, 1) * 0.35
    fill("slate", rgb(0.045, 0.06, 0.055) + chalk[..., None] * rgb(0.6, 0.62, 0.6), mix_normals(np.full((256 * K, half, 3), (0.5, 0.5, 1.0), np.float32), resize(concrete_n, 256 * K, half), 0.2), 0.88 - chalk * 0.2)
    fill("concrete", concrete[:half, :half], concrete_n[:half, :half], concrete_arm[:half, :half, 1], ao_map=concrete_arm[:half, :half, 0])
    fill("plaster", plaster[:half, :half], plaster_n[:half, :half], plaster_arm[:half, :half, 1], ao_map=plaster_arm[:half, :half, 0])
    # Paper: off-white, foxed where the concrete is dark, a crease or two.
    fox = resize(grime[..., None], 256 * K, 256 * K)[..., 0]
    paper = rgb(0.86, 0.85, 0.8) * (0.9 + 0.12 * (fox - fox.mean()))[..., None]
    fill("paper", paper, None, 0.9)
    # Doors and pedestals: brown-red paint over the plywood, worn through where the chips are.
    worn = np.clip((resize(chips[..., None], ATLAS, ATLAS)[..., 0] - 0.55) * 4, 0, 1)
    door = rgb(0.4, 0.16, 0.1) * (0.85 + 0.3 * luma(wood))[..., None]
    fill("door", door * (1 - worn[..., None]) + wood * worn[..., None], wood_n, 0.45 + worn * 0.3)
    # White enamel (light fittings, number plates) chipped to rust; black rubber and bakelite.
    band = (slice(0, 256 * K), slice(0, half))
    enamel_chips = np.clip((chips[band] - 0.75) * 4, 0, 1)
    enamel = rgb(0.84, 0.84, 0.8) * (1 - enamel_chips[..., None]) + rusty[band] * rgb(0.6, 0.42, 0.3) * enamel_chips[..., None]
    fill("enamel", enamel, rusty_n[band], 0.3 + enamel_chips * 0.5)
    fill("rubber", rgb(0.04, 0.04, 0.04) + resize(grime[..., None], 128 * K, 256 * K) * 0.04, None, 0.8)
    save(colour, os.path.join(out, "props_color.jpg"), COLOUR_QUALITY)
    save(normal, os.path.join(out, "props_normal.jpg"), DATA_QUALITY)
    save(orm, os.path.join(out, "props_orm.jpg"), DATA_QUALITY)


# ── Decals ──


def crack_network(peeling):
    """The peeling scan's cracks (thin dark lines) as a mask, 0..1."""
    lum = luma(peeling)
    return np.clip(((blur(lum, 5) - lum) - 0.035) * 25.0, 0, 1)


def fade(alpha, margin):
    """`alpha` eased to nothing over `margin` (a fraction of each side) at the image's edges, so a
    decal never shows its rectangle."""
    h, w = alpha.shape
    ramp = lambda n: np.clip(np.minimum(np.arange(n) + 0.5, n - np.arange(n) - 0.5) / (n * margin), 0, 1)  # noqa: E731
    return alpha * np.outer(ramp(h), ramp(w)) ** 0.7


def key_stain(image, floor):
    """A stain photographed on a white wall as a decal: the wall's colour is the image's bright end,
    each texel's cover how much it darkens the wall, its colour what darkens it; covers under
    `floor` (the wall's own grain) are dropped."""
    rgb_ = image[..., :3]
    wall = np.percentile(rgb_.reshape(-1, 3), 97, axis=0)
    cover = np.clip(1 - (rgb_ / wall).min(axis=-1), 0, 1)
    cover = np.clip((cover - floor) / (1 - floor), 0, 1) ** 0.8
    colour = np.clip((rgb_ - wall * (1 - cover[..., None])) / np.maximum(cover[..., None], 0.05), 0, 1)
    # Where nothing shows, the stain's mean colour: no bright junk bleeds in at its edges when filtered.
    mean = (colour * cover[..., None]).sum((0, 1)) / max(cover.sum(), 1e-6)
    colour = np.where(cover[..., None] < 0.02, mean, colour)
    return np.concatenate([colour, cover[..., None]], -1)


def key_chalk(image, mask):
    """Chalk photographed on a blackboard as a decal: white where the board is lightened, half-wiped
    dust where it is a little lighter; `mask` (0..1) wipes what must not show."""
    board = np.median(luma(image[..., :3]))
    lift = np.clip((luma(image[..., :3]) - board - 0.02) / 0.5, 0, 1) ** 0.85 * mask
    return np.concatenate([np.broadcast_to(rgb(0.86, 0.87, 0.84), lift.shape + (3,)), lift[..., None]], -1)


def key_peel(image):
    """Paint photographed peeling off plaster as a decal: the bare plaster and the flakes' shadows
    kept, the paint (bluer than grey) let through to the surface's own; its normal sinks the plaster
    below the paint."""
    rgb_ = image[..., :3]
    paint = np.clip((rgb_[..., 2] - rgb_[..., 0] - 0.05) / 0.12, 0, 1)
    bare = blur(1 - paint, 1)
    normal = normal_from_height(blur(paint, 2) * 4.0 + luma(rgb_) * 1.5, 1.0)
    return np.concatenate([rgb_, bare[..., None]], -1), normal


def torn(image, seed):
    """A poster as a decal: its paper opaque, its edges nibbled and one corner torn away."""
    h, w = image.shape[:2]
    rng = np.random.default_rng(seed)
    nibble = blur(rng.random((h, w)).astype(np.float32), 3)
    nibble = (nibble - nibble.mean()) / max(nibble.std(), 1e-6)
    edge = np.minimum.outer(np.minimum(np.arange(h), h - 1 - np.arange(h)), np.minimum(np.arange(w), w - 1 - np.arange(w)))
    alpha = (edge > 3 + 3 * nibble).astype(np.float32)
    y, x = np.mgrid[0:h, 0:w]
    corner = rng.integers(4)
    cy, cx = (0 if corner < 2 else h - 1), (0 if corner % 2 == 0 else w - 1)
    reach = min(h, w) * rng.uniform(0.12, 0.22)
    alpha *= (np.abs(y - cy) + np.abs(x - cx) > reach * (1 + 0.15 * nibble)).astype(np.float32)
    return np.concatenate([image[..., :3], blur(alpha, 1)[..., None]], -1)


def crop(image, top, bottom, left=0.0, right=1.0):
    """A part of an image by fractions of its height and width."""
    h, w = image.shape[:2]
    return image[int(h * top) : int(h * bottom), int(w * left) : int(w * right)]


def decals(scan, generated, out):
    folder = os.path.join(out, "decals")
    os.makedirs(folder, exist_ok=True)
    art = lambda name: read(os.path.join(generated, f"{name}.png"))  # noqa: E731
    # Peeled paint along an edge (the dado line, a sill) and in a patch, from one photograph.
    peel = art("peel")
    edge, edge_n = key_peel(crop(peel, 0.4, 0.85))
    edge[..., 3] = fade(edge[..., 3], 0.12)
    save(edge, os.path.join(folder, "peel_edge.png"), COLOUR_QUALITY)
    save(edge_n, os.path.join(folder, "peel_edge_normal.jpg"), DATA_QUALITY)
    patch, patch_n = key_peel(crop(peel, 0.0, 1.0, 0.22, 0.78))
    patch[..., 3] = fade(patch[..., 3], 0.3)
    save(patch, os.path.join(folder, "peel_patch.png"), COLOUR_QUALITY)
    save(patch_n, os.path.join(folder, "peel_patch_normal.jpg"), DATA_QUALITY)
    # Water: a leak running down from a sill, a stain spread on a ceiling.
    leak = key_stain(crop(art("leak"), 0.0, 0.92), 0.06)
    leak[..., 3] = fade(leak[..., 3], 0.08)
    save(leak, os.path.join(folder, "leak.png"), COLOUR_QUALITY)
    ceiling = key_stain(art("ceiling_stain"), 0.06)
    ceiling[..., 3] = fade(ceiling[..., 3], 0.1)
    save(ceiling, os.path.join(folder, "ceiling_stain.png"), COLOUR_QUALITY)
    # Grime rising from a floor: the photograph above its floor line, faded at its ends.
    grime = key_stain(crop(art("grime"), 0.55, 0.87), 0.04)
    grime[..., 3] = fade(grime[..., 3], 0.06)
    save(grime, os.path.join(folder, "grime_base.png"), COLOUR_QUALITY)
    # A lesson in chalk, cropped to the slate's shape, its date (a modern year) wiped off.
    chalk = crop(art("chalk"), 0.02, 0.86)
    h, w = chalk.shape[:2]
    wipe = np.ones((h, w), np.float32)
    wipe[: int(h * 0.14), int(w * 0.8) :] = 0.0
    save(key_chalk(chalk, blur(wipe, 6)), os.path.join(folder, "chalk.png"), COLOUR_QUALITY)
    for seed, name in enumerate(("poster_space", "poster_study", "poster_table", "poster_defence")):
        save(torn(art(name), seed), os.path.join(folder, f"{name}.png"), COLOUR_QUALITY)
    # A crack: the scan's own crack lines where a blob reaches, dark.
    lines = crack_network(scan("peeling_painted_wall", "diff")[256 * K : 768 * K, 256 * K : 768 * K])
    size = 512 * K
    reach = np.clip(1.2 - np.hypot(*np.meshgrid(np.arange(size) - size / 2, np.arange(size) - size / 2)) / (220.0 * K), 0, 1)
    crack = np.clip(blur(lines, K) * 2.0, 0, 1) * reach
    save(np.concatenate([np.broadcast_to(rgb(0.07, 0.065, 0.06), (size, size, 3)), crack[..., None]], -1), os.path.join(folder, "crack.png"), COLOUR_QUALITY)


def make(scans, out, strips, regions, generated):
    """Every sheet and decal from the scans under `scans` and the images in `generated`, into
    `out`, for the kit's trim `strips` and atlas `regions` (in 1k texels)."""
    cache = {}

    def scan(name, kind):
        if (name, kind) not in cache:
            cache[(name, kind)] = load(scans, name, kind)
        return cache[(name, kind)]

    trim_sheet(scan, {name: (top * K, bottom * K) for name, (top, bottom) in strips.items()}, out)
    props_atlas(scan, {name: tuple(v * K for v in box) for name, box in regions.items()}, out)
    decals(scan, generated, out)
    print("SHEETS into", out)
