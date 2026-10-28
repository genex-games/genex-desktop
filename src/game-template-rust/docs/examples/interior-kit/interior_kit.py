"""A modular interior kit for `blender__model`: every piece of an old school or office building as
its own small GLB, built on one grid so pieces snap together. The kit's GLBs, its trim sheet, its
props atlas and its decals ship ready in `docs/examples/interior-kit/assets/kit/`; run this script
only for a variant (another module width, ceiling height or window) or a new piece.

  blender__model {name: "<piece>", script: "assets/src/interior_kit.py"}

builds the piece called `<piece>` (one of `PIECES` below; a `-lod1` suffix builds its coarser level)
and `name: "interior-kit"` lays every piece out in a row to look at. It reads no input files.

The rules the pieces keep:
- One material per GLB, named for its role: `plaster`, `paint`, `concrete`, `trim`, `props`,
  `glass` or `tube`. The game gives each role its material in code (`frame.model_with`), so the GLBs
  carry no textures and a piece is a few kilobytes.
- Shell pieces (`plaster`, `paint`, `concrete`) have box-projected UVs in metres, but the game draws
  them with `Material::with_world_uv`: a CC0 scan at its real size across every piece, whatever its
  scale, with stochastic tiling so a long corridor never shows a tile twice.
- `trim` pieces map onto the trim sheet: u runs along the trim, one sheet width per metre, and the
  front face takes its strip's profile (a skirting's rounded top, an architrave's steps). `props`
  pieces map each box into one region of the props atlas at 512 texels per metre.

Axes: the game's (y up). A wall runs along x from -MODULE/2 to MODULE/2, its two faces at
z = +-WALL/2, its room face +z. Pieces that stand against a wall (radiator, lockers, blackboard) have
their back on z = 0 and face +z; free props stand on y = 0 and face +z. Blender is +Z up, so a game
point (x, y, z) is Blender's (x, -z, y), and the GLB export turns it back.
"""

import math
import random

import bmesh
from mathutils import Matrix, Vector

# The grid: a wall module's width, the storey's height and a wall's thickness (metres).
MODULE, HEIGHT, WALL = 2.0, 3.2, 0.25
FACE = WALL / 2
# A window opening: its width, sill and head; a door opening: its width and head.
WINDOW_WIDTH, SILL, HEAD = 1.6, 0.9, 2.6
DOOR_WIDTH, DOOR_HEAD = 1.0, 2.1
# The painted dado's top (the rail's centre), the skirting's height and how proud the trims stand.
DADO, SKIRTING = 1.3, 0.12
TRIM_PROUD, PAINT_PROUD = 0.02, 0.003
# Where a window's frame, glass and grille sit in the wall's depth (z, metres).
FRAME_DEPTH = (-0.07, 0.0)
GLASS_DEPTH = (-0.042, -0.038)
GRILLE_DEPTH = (-0.112, -0.096)
# The seed of every scattered or broken piece: change it for another arrangement.
SEED = 11

# The trim sheet: 1024 x 512 texels, one metre across, tiling along u. Each strip's rows (from the
# top) hold one profile; the faces beside the front take the strip's flat middle.
TRIM_SIZE = (1024, 512)
STRIPS = {
    "skirting": (0, 128),
    "rail": (128, 192),
    "architrave": (192, 304),
    "frame": (304, 384),
    "sash": (384, 432),
    "bar": (432, 480),
    "edge": (480, 512),
}
# The props atlas: 1024 x 1024 texels at 512 per metre, its regions (x0, y0, x1, y1 from the top left).
ATLAS_SIZE, ATLAS_DENSITY = 1024, 512
REGIONS = {
    "wood": (0, 0, 512, 512),
    "steel": (512, 0, 1024, 256),
    "locker": (512, 256, 1024, 512),
    "rust": (0, 512, 256, 768),
    "slate": (256, 512, 768, 768),
    "concrete": (768, 512, 1024, 768),
    "plaster": (0, 768, 256, 1024),
    "paper": (256, 768, 512, 1024),
    "door": (512, 768, 768, 1024),
    "enamel": (768, 768, 1024, 896),
    "rubber": (768, 896, 1024, 1024),
}
# Each role's viewport colour in the renders `blender__model` returns.
ROLE_COLOURS = {
    "plaster": (0.8, 0.78, 0.74),
    "paint": (0.25, 0.42, 0.55),
    "concrete": (0.55, 0.54, 0.5),
    "trim": (0.45, 0.22, 0.16),
    "props": (0.5, 0.42, 0.3),
    "glass": (0.6, 0.7, 0.75),
    "tube": (0.95, 0.97, 1.0),
}


class Piece:
    """One piece: boxes, prisms and tubes joined into one mesh with one material and its UVs."""

    def __init__(self, name, role, seed=SEED):
        self.name, self.role = name, role
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.pick = random.Random(f"{seed}:{name}")

    def quad(self, corners, normal, uvs):
        """A face from four game-space corners, wound to face `normal`, with their UVs."""
        a, b, c = (Vector(p) for p in corners[:3])
        if (b - a).cross(c - a).dot(Vector(normal)) < 0:
            corners, uvs = corners[::-1], uvs[::-1]
        verts = [self.bm.verts.new(blender(p)) for p in corners]
        face = self.bm.faces.new(verts)
        for loop, (u, v) in zip(face.loops, uvs):
            loop[self.uv].uv = (u, 1.0 - v)

    def box(self, lo, hi, uv=("metres",), turn=None):
        """A box from `lo` to `hi` (game axes), its faces mapped by `uv`, then moved by `turn` (a
        matrix about the origin, see `rotation`)."""
        if min(h - l for l, h in zip(lo, hi)) <= 1e-5:
            return
        for axis in range(3):
            for side in (0, 1):
                corners = face_corners(lo, hi, axis, side)
                normal = [0.0, 0.0, 0.0]
                normal[axis] = 1.0 if side else -1.0
                uvs = self.face_uvs(corners, lo, hi, axis, uv)
                if turn is not None:
                    corners = [tuple(turn @ Vector(p)) for p in corners]
                    normal = tuple(turn.to_3x3() @ Vector(normal))
                self.quad(corners, normal, uvs)

    def face_uvs(self, corners, lo, hi, axis, uv):
        kind = uv[0]
        if kind == "trim":
            return trim_uvs(corners, lo, hi, axis, uv[1], uv[2], uv[3] if len(uv) > 3 else 2)
        if kind == "atlas":
            return self.atlas_uvs(corners, axis, uv[1])
        u_axis, v_axis = plane_axes(axis)
        return [(p[u_axis], -p[v_axis] if v_axis == 1 else p[v_axis]) for p in corners]

    def atlas_uvs(self, corners, axis, region):
        """The face in `region` of the props atlas at its density, shrunk to fit when larger and
        placed at a seeded spot when smaller, so no two faces show the same patch."""
        x0, y0, x1, y1 = REGIONS[region]
        u_axis, v_axis = plane_axes(axis)
        us = [p[u_axis] * ATLAS_DENSITY for p in corners]
        vs = [-p[v_axis] * ATLAS_DENSITY if v_axis == 1 else p[v_axis] * ATLAS_DENSITY for p in corners]
        width, height = max(us) - min(us), max(vs) - min(vs)
        room_w, room_h = x1 - x0 - 4, y1 - y0 - 4
        scale = min(1.0, room_w / max(width, 1e-6), room_h / max(height, 1e-6))
        du = x0 + 2 + self.pick.uniform(0, room_w - width * scale)
        dv = y0 + 2 + self.pick.uniform(0, room_h - height * scale)
        u0, v0 = min(us), min(vs)
        return [(((u - u0) * scale + du) / ATLAS_SIZE, ((v - v0) * scale + dv) / ATLAS_SIZE) for u, v in zip(us, vs)]

    def prism(self, profile, x0, x1, uv=("metres",)):
        """A profile in (z, y), counter-clockwise, extruded along x from `x0` to `x1`: a chamfered beam."""
        lo = (x0, min(y for _, y in profile), min(z for z, _ in profile))
        hi = (x1, max(y for _, y in profile), max(z for z, _ in profile))
        for (za, ya), (zb, yb) in zip(profile, profile[1:] + profile[:1]):
            corners = [(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)]
            normal = (0.0, zb - za, -(yb - ya))
            axis = 1 if abs(zb - za) > abs(yb - ya) else 2
            self.quad(corners, normal, self.face_uvs(corners, lo, hi, axis, uv))
        for x, sign in ((x0, -1.0), (x1, 1.0)):
            verts = [self.bm.verts.new(blender((x, y, z))) for z, y in profile]
            face = self.bm.faces.new(verts if sign > 0 else verts[::-1])
            for loop, (z, y) in zip(face.loops, profile):
                loop[self.uv].uv = (z, y)
        self.bm.normal_update()

    def tube(self, a, b, radius, segments=8, uv=("metres",)):
        """A capped cylinder from `a` to `b` (game axes)."""
        a, b = Vector(a), Vector(b)
        along = (b - a).normalized()
        side = along.orthogonal().normalized()
        up = along.cross(side)
        rings = []
        for end in (a, b):
            ring = []
            for i in range(segments):
                angle = math.tau * i / segments
                ring.append(end + (side * math.cos(angle) + up * math.sin(angle)) * radius)
            rings.append(ring)
        length = (b - a).length
        for i in range(segments):
            j = (i + 1) % segments
            corners = [tuple(rings[0][i]), tuple(rings[1][i]), tuple(rings[1][j]), tuple(rings[0][j])]
            mid = (rings[0][i] + rings[0][j]) / 2 - a
            us = [i / segments, i / segments, (i + 1) / segments, (i + 1) / segments]
            vs = [0.0, length, length, 0.0]
            if uv[0] == "atlas":
                uvs = self.atlas_uvs([(u * math.tau * radius, -v, 0.0) for u, v in zip(us, vs)], 2, uv[1])
            else:
                uvs = list(zip(us, vs))
            self.quad(corners, tuple(mid), uvs)
        for ring, sign in ((rings[0], -1.0), (rings[1], 1.0)):
            verts = [self.bm.verts.new(blender(tuple(p))) for p in ring]
            face = self.bm.faces.new(verts)
            face.normal_update()
            if face.normal.dot(Vector(blender(tuple(along * sign)))) < 0:
                face.normal_flip()

    def bar(self, start, end, width, z, uv):
        """A flat bar in the plane z = depth range, from (x, y) `start` to `end`: a grille's ray."""
        (sx, sy), (ex, ey) = start, end
        length = math.hypot(ex - sx, ey - sy)
        turn = Matrix.Translation((sx, sy, 0.0)) @ rotation("z", math.degrees(math.atan2(ey - sy, ex - sx)))
        self.box((0.0, -width / 2, z[0]), (length, width / 2, z[1]), uv, turn)

    def finish(self):
        """The piece as a mesh object with its one material."""
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        mesh.materials.append(role_material(self.role))
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def blender(p):
    """A game-space point in Blender's axes."""
    x, y, z = p
    return (x, -z, y)


def rotation(axis, degrees, pivot=(0.0, 0.0, 0.0)):
    """A turn about the game axis `axis` through `pivot`."""
    to = Matrix.Translation(pivot)
    return to @ Matrix.Rotation(math.radians(degrees), 4, axis.upper()) @ to.inverted()


def plane_axes(axis):
    """The two axes a face across `axis` spans: (u, v), v up the wall where there is one."""
    return {0: (2, 1), 1: (0, 2), 2: (0, 1)}[axis]


def face_corners(lo, hi, axis, side):
    """The four corners of a box's face across `axis` (`side` 1: the high one), in order round it."""
    u_axis, v_axis = plane_axes(axis)
    out = []
    for cu, cv in ((0, 0), (1, 0), (1, 1), (0, 1)):
        p = [0.0, 0.0, 0.0]
        p[axis] = hi[axis] if side else lo[axis]
        p[u_axis] = hi[u_axis] if cu else lo[u_axis]
        p[v_axis] = hi[v_axis] if cv else lo[v_axis]
        out.append(tuple(p))
    return out


def trim_uvs(corners, lo, hi, axis, strip, along, front):
    """A trim's face on the trim sheet: u along the trim in metres; the front face across its strip
    (the box's top edge at the strip's top row), every other face on the strip's flat middle."""
    top, bottom = STRIPS[strip]
    across = 3 - along - front
    rows = TRIM_SIZE[1]
    if axis == front:
        span = hi[across] - lo[across]
        return [(p[along], (top + (bottom - top) * (hi[across] - p[across]) / span) / rows) for p in corners]
    mid = (top + bottom) / 2
    other = across if axis == along else 3 - along - axis
    span = max(hi[other] - lo[other], 1e-6)
    return [(p[along], (mid - 3 + 6 * (p[other] - lo[other]) / span) / rows) for p in corners]


def role_material(role):
    """The role's material: a plain colour for the renders; the game draws it with its own."""
    material = bpy.data.materials.get(role)
    if material is not None:
        return material
    material = bpy.data.materials.new(role)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*ROLE_COLOURS[role], 1.0)
    shader.inputs["Roughness"].default_value = 0.7
    material.diffuse_color = (*ROLE_COLOURS[role], 1.0)
    return material


def TRIM(strip, along=0, front=2):
    """Map a box onto the trim sheet's `strip`: the trim runs along `along`, its profile faces `front`."""
    return ("trim", strip, along, front)


def ATLAS(region):
    """Map a box into the props atlas's `region`."""
    return ("atlas", region)


HALF = MODULE / 2
# The window's transom: casements below, fixed lights above.
TRANSOM = 2.05


# ── Walls ── the shell (plaster), its dado coat (paint) and its trims (trim), for each kind.


def openings(kind):
    """A wall kind's hole: (x from, x to, sill, head), or None."""
    if kind == "window":
        return (-WINDOW_WIDTH / 2, WINDOW_WIDTH / 2, SILL, HEAD)
    if kind == "door":
        return (-DOOR_WIDTH / 2, DOOR_WIDTH / 2, 0.0, DOOR_HEAD)
    return None


def wall_shell(p, kind):
    """A module's wall, its opening's sides being the reveals."""
    hole = openings(kind)
    if hole is None:
        p.box((-HALF, 0.0, -FACE), (HALF, HEIGHT, FACE))
        return
    x0, x1, sill, head = hole
    p.box((-HALF, 0.0, -FACE), (x0, HEIGHT, FACE))
    p.box((x1, 0.0, -FACE), (HALF, HEIGHT, FACE))
    p.box((x0, 0.0, -FACE), (x1, sill, FACE))
    p.box((x0, head, -FACE), (x1, HEIGHT, FACE))


def wall_paint(p, kind):
    """The dado's coat of oil paint on the room face, and on a window's reveals below the dado."""
    hole = openings(kind)
    lo_z, hi_z = FACE, FACE + PAINT_PROUD
    if hole is None:
        p.box((-HALF, 0.0, lo_z), (HALF, DADO, hi_z))
        return
    x0, x1, sill, _ = hole
    edge = x0 - 0.1 if kind == "door" else x0
    p.box((-HALF, 0.0, lo_z), (edge, DADO, hi_z))
    p.box((-edge, 0.0, lo_z), (HALF, DADO, hi_z))
    if kind == "window":
        p.box((x0, 0.0, lo_z), (x1, sill, hi_z))
        for x, inward in ((x0, PAINT_PROUD), (x1, -PAINT_PROUD)):
            p.box((min(x, x + inward), sill, FRAME_DEPTH[1]), (max(x, x + inward), DADO, FACE))


def wall_trims(p, kind):
    """The skirting along the floor and the dado rail, stopped at the opening."""
    hole = openings(kind)
    skirting, rail = TRIM("skirting"), TRIM("rail")
    spans = [(-HALF, HALF)]
    if hole is not None:
        edge = hole[0] - 0.1 if kind == "door" else hole[0]
        spans = [(-HALF, edge), (-edge, HALF)]
    for a, b in spans:
        p.box((a, DADO - 0.03, FACE), (b, DADO + 0.03, FACE + TRIM_PROUD + 0.005), rail)
    if kind == "window":
        spans = [(-HALF, HALF)]
    for a, b in spans:
        p.box((a, 0.0, FACE), (b, SKIRTING, FACE + TRIM_PROUD), skirting)


def corner(p):
    """The outer corner's square where a wall ending at x = 0 meets one leaving towards +z."""
    p.box((0.0, 0.0, -FACE), (FACE, HEIGHT, 0.0))


def pilaster(p):
    """A pier standing 12 cm proud of the room face, at a module joint."""
    p.box((-0.2, 0.0, FACE), (0.2, HEIGHT, FACE + 0.12))


def pilaster_paint(p):
    lo, hi = FACE + 0.12, FACE + 0.12 + PAINT_PROUD
    p.box((-0.2, 0.0, lo), (0.2, DADO, hi))
    for x, inward in ((-0.2, -PAINT_PROUD), (0.2, PAINT_PROUD)):
        p.box((min(x, x + inward), 0.0, FACE), (max(x, x + inward), DADO, lo))


def pilaster_trims(p):
    skirting, front = TRIM("skirting"), FACE + 0.12
    p.box((-0.2 - TRIM_PROUD, 0.0, front), (0.2 + TRIM_PROUD, SKIRTING, front + TRIM_PROUD), skirting)
    for x0, x1 in ((-0.2 - TRIM_PROUD, -0.2), (0.2, 0.2 + TRIM_PROUD)):
        p.box((x0, 0.0, FACE), (x1, SKIRTING, front), TRIM("skirting", 2, 0))


# ── Windows and doors ── each sits in its wall kind's opening, at the wall's own transform.


def window_frame(p):
    """The frame lining the opening: jambs, head, bottom rail, transom and mullions."""
    x0, x1, sill, head = openings("window")
    z, w, bottom = FRAME_DEPTH, 0.06, sill + 0.005
    frame_v, frame_h = TRIM("frame", 1), TRIM("frame")
    for a in (x0, x1 - w):
        p.box((a, bottom, z[0]), (a + w, head, z[1]), frame_v)
    for y in (bottom, head - w, TRANSOM):
        p.box((x0 + w, y, z[0]), (x1 - w, y + w, z[1]), frame_h)
    p.box((-0.03, bottom + w, z[0]), (0.03, TRANSOM, z[1]), frame_v)
    p.box((-0.02, TRANSOM + w, z[0]), (0.02, head - w, z[1]), frame_v)



def window_cells():
    """The glazed cells inside the frame: two casements below the transom, two lights above."""
    x0, x1, sill, head = openings("window")
    w, bottom = 0.06, sill + 0.005 + 0.06
    return [((x0 + w, bottom), (-0.03, TRANSOM)), ((0.03, bottom), (x1 - w, TRANSOM)),
            ((x0 + w, TRANSOM + w), (-0.02, head - w)), ((0.02, TRANSOM + w), (x1 - w, head - w))]


def window_sash(p):
    """Each cell's sash: a frame of bars, the casements with a glazing bar across."""
    w, z = 0.045, (-0.062, -0.018)
    for i, ((a, b), (c, d)) in enumerate(window_cells()):
        for x in (a, c - w):
            p.box((x, b, z[0]), (x + w, d, z[1]), TRIM("sash", 1))
        for y in (b, d - w):
            p.box((a + w, y, z[0]), (c - w, y + w, z[1]), TRIM("sash"))
        if i < 2:
            mid = (b + d) / 2
            p.box((a + w, mid - 0.015, z[0] + 0.01), (c - w, mid + 0.015, z[1] - 0.01), TRIM("sash"))


def panes():
    """Every pane: inside its sash, the casements split by their glazing bar."""
    w, out = 0.045, []
    for i, ((a, b), (c, d)) in enumerate(window_cells()):
        a, b, c, d = a + w, b + w, c - w, d - w
        if i < 2:
            mid = (b + d) / 2
            out += [((a, b), (c, mid - 0.015)), ((a, mid + 0.015), (c, d))]
        else:
            out.append(((a, b), (c, d)))
    return out


def window_glass(p):
    for (a, b), (c, d) in panes():
        p.box((a, b, GLASS_DEPTH[0]), (c, d, GLASS_DEPTH[1]))


def window_glass_broken(p):
    """Panes after a winter of stones: some gone, some held by the shards left in their corners."""
    for (a, b), (c, d) in panes():
        fate = p.pick.random()
        if fate < 0.3:
            continue
        if fate > 0.8:
            p.box((a, b, GLASS_DEPTH[0]), (c, d, GLASS_DEPTH[1]))
            continue
        for cx, cy in ((a, b), (c, b), (a, d), (c, d)):
            if p.pick.random() < 0.45:
                continue
            reach = p.pick.uniform(0.25, 0.7)
            px = cx + (a + c - 2 * cx) * reach * p.pick.uniform(0.3, 1.0)
            py = cy + (b + d - 2 * cy) * reach * p.pick.uniform(0.3, 1.0)
            shard(p, (cx, cy), (px, cy), (cx, py))


def shard(p, a, b, c):
    """A triangle of glass, both faces."""
    z = (GLASS_DEPTH[0] + GLASS_DEPTH[1]) / 2
    corners = [(a[0], a[1], z), (b[0], b[1], z), (c[0], c[1], z)]
    for normal in ((0, 0, 1), (0, 0, -1)):
        pts = corners if normal[2] > 0 else corners[::-1]
        verts = [p.bm.verts.new(blender(q)) for q in pts]
        face = p.bm.faces.new(verts)
        for loop, q in zip(face.loops, pts):
            loop[p.uv].uv = (q[0], q[1])


def window_grille_bars(p):
    """Square steel bars in the reveal outside the glass, with two flats across."""
    x0, x1, sill, head = openings("window")
    z, bar = GRILLE_DEPTH, TRIM("bar", 1)
    count = 11
    for i in range(count):
        x = x0 + (x1 - x0) * (i + 1) / (count + 1)
        p.box((x - 0.008, sill + 0.005, z[0]), (x + 0.008, head, z[1]), bar)
    for y in (1.45, 2.15):
        p.box((x0, y - 0.02, z[0] - 0.004), (x1, y + 0.02, z[0]), TRIM("bar"))


def window_grille_sunburst(p, rays=13, hub_segments=10):
    """The rising-sun grille: a frame of flats, a half hub on the sill and rays out to the frame."""
    x0, x1, sill, head = openings("window")
    z, flat = GRILLE_DEPTH, TRIM("bar")
    b, w = sill + 0.005, 0.03
    p.box((x0, b, z[0]), (x1, b + w, z[1]), flat)
    p.box((x0, head - w, z[0]), (x1, head, z[1]), flat)
    p.box((x0, b, z[0]), (x0 + w, head, z[1]), TRIM("bar", 1))
    p.box((x1 - w, b, z[0]), (x1, head, z[1]), TRIM("bar", 1))
    hub = 0.24
    for i in range(hub_segments):
        a0, a1 = math.pi * i / hub_segments, math.pi * (i + 1) / hub_segments
        p.bar((math.cos(a0) * hub, b + math.sin(a0) * hub), (math.cos(a1) * hub, b + math.sin(a1) * hub), w, z, flat)
    for i in range(rays):
        angle = math.pi * (i + 1) / (rays + 1)
        start = (math.cos(angle) * hub, b + math.sin(angle) * hub)
        end = ray_end(start, angle, (x0 + w, b + w, x1 - w, head - w))
        p.bar(start, end, 0.022, z, flat)


def ray_end(start, angle, bounds):
    """Where a ray from `start` at `angle` meets the inside of the frame `bounds` (x0, y0, x1, y1)."""
    x0, _, x1, y1 = bounds
    dx, dy = math.cos(angle), math.sin(angle)
    hits = []
    if dx > 1e-6:
        hits.append((x1 - start[0]) / dx)
    if dx < -1e-6:
        hits.append((x0 - start[0]) / dx)
    if dy > 1e-6:
        hits.append((y1 - start[1]) / dy)
    t = min(hits)
    return (start[0] + dx * t, start[1] + dy * t)


def window_sill(p):
    """A concrete sill through the wall: proud of the room face, dripping off the outside."""
    x0, x1, sill, _ = openings("window")
    p.box((x0 - 0.06, sill - 0.04, -FACE - 0.04), (x1 + 0.06, sill + 0.005, FACE + 0.05))


def door_frame(p):
    """Linings in the reveal and an architrave on both faces."""
    x0, x1, _, head = openings("door")
    lining = 0.03
    for a in (x0, x1 - lining):
        p.box((a, 0.0, -FACE), (a + lining, head, FACE), TRIM("frame", 1, 0))
    p.box((x0, head - lining, -FACE), (x1, head, FACE), TRIM("frame", 0, 1))
    for z0, z1 in ((FACE, FACE + TRIM_PROUD), (-FACE - TRIM_PROUD, -FACE)):
        for a in (x0 - 0.1, x1):
            p.box((a, 0.0, z0), (a + 0.1, head + 0.1, z1), TRIM("architrave", 1))
        p.box((x0, head, z0), (x1, head + 0.1, z1), TRIM("architrave"))


def door(p):
    """A panelled leaf hung from its hinge at x = 0, closing along +x: stiles, rails, two sunk
    panels, a lever on each face. Turn it about y to open it."""
    width, height, half = 0.94, 2.065, 0.0225
    paint = ATLAS("door")
    stile, rails = 0.12, ((0.01, 0.23), (0.95, 1.13), (height - 0.12, height))
    for a in (0.0, width - stile):
        p.box((a, 0.01, -half), (a + stile, height, half), paint)
    for y0, y1 in rails:
        p.box((stile, y0, -half), (width - stile, y1, half), paint)
    for (_, below), (above, _) in zip(rails, rails[1:]):
        p.box((stile, below, -0.01), (width - stile, above, 0.01), paint)
    for sign in (1, -1):
        # A lever on each face: its rose and neck out of the leaf, its grip back towards the hinge.
        neck = sorted((sign * half, sign * (half + 0.05)))
        grip = sorted((sign * (half + 0.038), sign * (half + 0.05)))
        p.box((width - 0.1, 1.0, neck[0]), (width - 0.08, 1.06, neck[1]), ATLAS("rubber"))
        p.box((width - 0.2, 1.02, grip[0]), (width - 0.08, 1.045, grip[1]), ATLAS("rubber"))


# ── Ceiling ──


def beam(p):
    """A concrete beam one metre long (scale it along x), its soffit's edges chamfered; its top at
    y = 0, so it hangs from the ceiling it is placed at."""
    p.prism([(-0.15, 0.0), (-0.15, -0.38), (-0.13, -0.4), (0.13, -0.4), (0.15, -0.38), (0.15, 0.0)], -0.5, 0.5)


def light_fitting(p):
    """A twin-tube fluorescent fitting hung 30 cm below the ceiling on two rods, its diffuser gone:
    an enamelled channel with flared sides and lamp holders at the ends."""
    enamel, holder = ATLAS("enamel"), ATLAS("rubber")
    for x in (-0.45, 0.45):
        p.box((x - 0.006, -0.3, -0.006), (x + 0.006, 0.0, 0.006), enamel)
    p.box((-0.63, -0.33, -0.06), (0.63, -0.3, 0.06), enamel)
    for sign in (1, -1):
        # A reflector flaring down and out from each side of the channel.
        z0, z1 = sorted((sign * 0.06, sign * 0.13))
        p.box((-0.63, -0.333, z0), (0.63, -0.327, z1), enamel, rotation("x", sign * 35.0, (0.0, -0.33, sign * 0.06)))
    for x in (-0.63, 0.6):
        p.box((x, -0.39, -0.055), (x + 0.03, -0.33, 0.055), holder)


def light_tube(p):
    """The fitting's two tubes: draw them with an emissive material and pair a light with them."""
    for z in (-0.03, 0.03):
        p.tube((-0.6, -0.36, z), (0.6, -0.36, z), 0.013)


def radiator(p, lod=0):
    """A cast-iron column radiator 0.78 m wide on two feet, its back on the wall (z = 0), with its
    pipe going down into the floor."""
    steel, sections, pitch = ATLAS("steel"), 12, 0.065
    width = sections * pitch
    left = -width / 2
    for y0, y1 in ((0.12, 0.18), (0.66, 0.72)):
        p.box((left, y0, 0.05), (-left, y1, 0.17), steel)
    if lod:
        p.box((left, 0.18, 0.06), (-left, 0.66, 0.16), steel)
    else:
        for i in range(sections):
            x = left + i * pitch + 0.008
            for z0 in (0.05, 0.12):
                p.box((x, 0.18, z0), (x + pitch - 0.016, 0.66, z0 + 0.05), steel)
    for x in (left + 0.04, -left - 0.1):
        p.box((x, 0.0, 0.07), (x + 0.06, 0.12, 0.15), steel)
    p.tube((left - 0.05, 0.0, 0.11), (left - 0.05, 0.69, 0.11), 0.016, uv=steel)
    p.box((left - 0.05, 0.67, 0.09), (left, 0.71, 0.13), steel)


# ── Classroom props ── free props stand on y = 0 and face +z; against-the-wall ones have their back on z = 0.


def leg(p, x, z, top, region="steel", size=0.025, bottom=0.0, turn=None):
    p.box((x - size / 2, bottom, z - size / 2), (x + size / 2, top, z + size / 2), ATLAS(region), turn)


def desk(p, lod=0, broken=False):
    """A two-seat school desk: a wooden top on a square-tube frame with a book shelf under it. Broken,
    its front right leg is gone, the other right one bent, and the top has dropped onto them."""
    top_y, w, d = 0.72, 0.6, 0.25
    sag = rotation("z", -11.0, (-w, top_y, 0.0)) if broken else None
    p.box((-w, top_y - 0.025, -d), (w, top_y, d), ATLAS("wood"), sag)
    p.box((-w + 0.05, 0.58, -d + 0.03), (w - 0.05, 0.585, d - 0.1), ATLAS("steel"), sag)
    for x in (-w + 0.04, w - 0.04):
        for z in (-d + 0.04, d - 0.04):
            if broken and x > 0 and z > 0:
                continue
            if broken and x > 0:
                leg(p, x, z, 0.48, turn=rotation("z", 24.0, (x, 0.0, z)))
                continue
            leg(p, x, z, top_y - 0.025)
    if lod:
        return
    for x in (-w + 0.04, w - 0.04):
        if broken and x > 0:
            continue
        p.box((x - 0.01, 0.64, -d + 0.04), (x + 0.01, 0.66, d - 0.04), ATLAS("steel"))
        p.box((x - 0.01, 0.08, -d + 0.04), (x + 0.01, 0.1, d - 0.04), ATLAS("steel"))
    p.box((-w + 0.04, 0.3, -d + 0.03), (w - 0.04 if not broken else 0.1, 0.32, -d + 0.05), ATLAS("steel"))


def chair(p, lod=0, broken=False):
    """A school chair: plywood seat and back on a tube frame, the back raked 8 degrees. Broken, its
    back is gone, one upright bent out and the seat cracked across, its front half hanging."""
    seat_y, s = 0.445, 0.19
    rake = rotation("x", -8.0, (0.0, seat_y, -s))
    if broken:
        p.box((-s - 0.01, seat_y - 0.015, -s), (s + 0.01, seat_y, 0.0), ATLAS("wood"))
        p.box((-s - 0.01, seat_y - 0.015, 0.0), (s + 0.01, seat_y, s), ATLAS("wood"), rotation("x", 32.0, (0.0, seat_y, 0.0)))
    else:
        p.box((-s - 0.01, seat_y - 0.015, -s), (s + 0.01, seat_y, s), ATLAS("wood"))
        p.box((-s - 0.01, 0.62, -s - 0.02), (s + 0.01, 0.79, -s - 0.008), ATLAS("wood"), rake)
    for x in (-0.17, 0.17):
        for z in (-0.17, 0.17):
            leg(p, x, z, seat_y - 0.015, size=0.022)
        upright = rake if not (broken and x > 0) else rotation("z", -20.0, (x, seat_y, -0.17)) @ rake
        leg(p, x, -0.17, 0.8, size=0.022, bottom=seat_y - 0.015, turn=upright)
    if lod:
        return
    for x in (-0.17, 0.17):
        p.box((x - 0.009, 0.13, -0.17), (x + 0.009, 0.15, 0.17), ATLAS("steel"))
        p.box((x - 0.009, seat_y - 0.045, -0.17), (x + 0.009, seat_y - 0.015, 0.17), ATLAS("steel"))
    p.box((-0.17, seat_y - 0.045, 0.16), (0.17, seat_y - 0.015, 0.18), ATLAS("steel"))
    for y in (0.2, 0.33):
        p.box((-0.17, y, -0.18), (0.17, y + 0.016, -0.16), ATLAS("steel"))


def lockers(p, lod=0):
    """A bank of three steel lockers on a plinth, back on the wall: louvred doors, handles, number plates."""
    paint, width, depth = ATLAS("locker"), 0.3, 0.45
    left = -1.5 * width
    p.box((left + 0.02, 0.0, 0.02), (-left - 0.02, 0.1, depth - 0.04), ATLAS("rubber"))
    p.box((left, 0.1, 0.0), (-left, 1.85, depth - 0.02), paint)
    for i in range(3):
        x0 = left + i * width + 0.004
        x1 = x0 + width - 0.008
        p.box((x0, 0.12, depth - 0.02), (x1, 1.83, depth), paint)
        if lod:
            continue
        for y in (0.22, 0.27, 0.32, 1.6, 1.65, 1.7):
            p.box((x0 + 0.06, y, depth), (x1 - 0.06, y + 0.018, depth + 0.006), paint)
        p.box((x1 - 0.05, 0.98, depth), (x1 - 0.035, 1.12, depth + 0.025), ATLAS("rubber"))
        p.box((x0 + 0.1, 1.76, depth), (x1 - 0.1, 1.79, depth + 0.002), ATLAS("enamel"))


def teacher_desk(p):
    """The teacher's desk: a wide top over a pedestal of three drawers, a modesty panel and a side panel."""
    wood, w, d, top = ATLAS("wood"), 0.7, 0.35, 0.77
    p.box((-w, top - 0.03, -d), (w, top, d), wood)
    p.box((-w + 0.02, 0.0, -d + 0.02), (-w + 0.44, top - 0.03, d - 0.02), ATLAS("door"))
    for i, (y0, y1) in enumerate(((0.04, 0.27), (0.29, 0.5), (0.52, 0.71))):
        p.box((-w + 0.04, y0, d - 0.02), (-w + 0.42, y1, d), ATLAS("door"))
        p.box((-w + 0.18, (y0 + y1) / 2 - 0.01, d), (-w + 0.28, (y0 + y1) / 2 + 0.01, d + 0.02), ATLAS("rubber"))
    p.box((w - 0.04, 0.0, -d + 0.02), (w - 0.02, top - 0.03, d - 0.02), ATLAS("door"))
    p.box((-w + 0.44, 0.3, -d + 0.02), (w - 0.04, top - 0.03, -d + 0.04), ATLAS("door"))


def blackboard(p):
    """A 2.4 m slate in a wooden frame with a chalk tray and a few sticks of chalk, back on the wall."""
    w, bottom, top = 1.2, 0.95, 2.05
    p.box((-w, bottom, 0.0), (w, top, 0.02), ATLAS("slate"))
    for y0, y1 in ((bottom - 0.05, bottom), (top, top + 0.05)):
        p.box((-w - 0.05, y0, 0.0), (w + 0.05, y1, 0.035), ATLAS("wood"))
    for x0 in (-w - 0.05, w):
        p.box((x0, bottom, 0.0), (x0 + 0.05, top, 0.035), ATLAS("wood"))
    p.box((-w, bottom - 0.08, 0.0), (w, bottom - 0.05, 0.08), ATLAS("wood"))
    p.box((-w, bottom - 0.05, 0.065), (w, bottom - 0.03, 0.08), ATLAS("wood"))
    for x in (-0.7, -0.62, 0.3, 0.9):
        spin = rotation("y", p.pick.uniform(-30, 30), (x, bottom - 0.05, 0.04))
        p.box((x - 0.04, bottom - 0.05, 0.035), (x + 0.04, bottom - 0.04, 0.045), ATLAS("paper"), spin)


# ── Rubble and litter ── scattered from SEED round their origin, on y = 0.


def debris_pile(p, chunks=46, radius=0.75, height=0.38):
    """Concrete and plaster heaped in a mound: chunks of every size, at every angle, bigger at the bottom."""
    for _ in range(chunks):
        r = radius * math.sqrt(p.pick.random())
        angle = p.pick.uniform(0, math.tau)
        x, z = math.cos(angle) * r, math.sin(angle) * r
        ground = height * (1 - r / radius) ** 1.5
        size = p.pick.uniform(0.05, 0.26) * (1.2 - 0.6 * r / radius)
        dims = (size, size * p.pick.uniform(0.3, 0.8), size * p.pick.uniform(0.5, 1.0))
        y = max(dims[1] / 2, ground * p.pick.uniform(0.4, 1.0))
        turn = Matrix.Translation((x, y, z)) @ rotation("y", p.pick.uniform(0, 360)) @ rotation("x", p.pick.uniform(-35, 35)) @ rotation("z", p.pick.uniform(-35, 35))
        region = "concrete" if p.pick.random() < 0.7 else "plaster"
        p.box(tuple(-d / 2 for d in dims), tuple(d / 2 for d in dims), ATLAS(region), turn)


def fallen_plaster(p, slabs=18, spread=0.8):
    """Slabs of ceiling plaster flat on the floor, painted face up, a few leaning on each other."""
    for _ in range(slabs):
        x, z = p.pick.uniform(-spread, spread), p.pick.uniform(-spread * 0.7, spread * 0.7)
        w, d, t = p.pick.uniform(0.1, 0.45), p.pick.uniform(0.08, 0.35), p.pick.uniform(0.012, 0.03)
        tilt = p.pick.uniform(-6, 6) if p.pick.random() < 0.8 else p.pick.uniform(15, 30)
        turn = Matrix.Translation((x, t / 2 + 0.002 + abs(math.sin(math.radians(tilt))) * w / 2, z)) @ rotation("y", p.pick.uniform(0, 360)) @ rotation("z", tilt)
        p.box((-w / 2, -t / 2, -d / 2), (w / 2, t / 2, d / 2), ATLAS("plaster"), turn)


def paper_litter(p, sheets=28, spread=(1.0, 0.7)):
    """Exercise-book pages blown into drifts: flat, curled up at an edge, or folded in two."""
    w, d, t = 0.21, 0.297, 0.0012
    for _ in range(sheets):
        x, z = p.pick.uniform(-spread[0], spread[0]), p.pick.uniform(-spread[1], spread[1])
        place = Matrix.Translation((x, t / 2 + 0.001 + p.pick.uniform(0, 0.004), z)) @ rotation("y", p.pick.uniform(0, 360))
        if p.pick.random() < 0.35:
            fold = p.pick.uniform(20, 70)
            p.box((-w / 2, -t / 2, -d / 2), (w / 2, t / 2, 0.0), ATLAS("paper"), place)
            p.box((-w / 2, -t / 2, 0.0), (w / 2, t / 2, d / 2), ATLAS("paper"), place @ rotation("x", fold))
        else:
            p.box((-w / 2, -t / 2, -d / 2), (w / 2, t / 2, d / 2), ATLAS("paper"), place @ rotation("x", p.pick.uniform(-4, 4)))


def bench(p):
    """A park bench for outside: wooden slats on two rusted cast-iron ends."""
    w = 0.8
    for z in (0.12, 0.0, -0.12):
        p.box((-w, 0.42, z - 0.045), (w, 0.45, z + 0.045), ATLAS("wood"))
    lean = rotation("x", -14.0, (0.0, 0.47, -0.2))
    for y in (0.55, 0.68):
        p.box((-w, y, -0.23), (w, y + 0.09, -0.2), ATLAS("wood"), lean)
    for x in (-w + 0.08, w - 0.12):
        p.box((x, 0.0, 0.14), (x + 0.04, 0.42, 0.18), ATLAS("rust"))
        p.box((x, 0.0, -0.2), (x + 0.04, 0.42, -0.16), ATLAS("rust"))
        p.box((x, 0.38, -0.2), (x + 0.04, 0.42, 0.18), ATLAS("rust"))
        p.box((x, 0.42, -0.24), (x + 0.04, 0.8, -0.2), ATLAS("rust"), lean)


# Every piece: its name, its role and how it is built. `-lod1` names take the builder's lod=1.
PIECES = {
    "wall": ("plaster", lambda p: wall_shell(p, "plain")),
    "wall-window": ("plaster", lambda p: wall_shell(p, "window")),
    "wall-door": ("plaster", lambda p: wall_shell(p, "door")),
    "wall-corner": ("plaster", corner),
    "pilaster": ("plaster", pilaster),
    "wall-paint": ("paint", lambda p: wall_paint(p, "plain")),
    "wall-window-paint": ("paint", lambda p: wall_paint(p, "window")),
    "wall-door-paint": ("paint", lambda p: wall_paint(p, "door")),
    "pilaster-paint": ("paint", pilaster_paint),
    "wall-trims": ("trim", lambda p: wall_trims(p, "plain")),
    "wall-window-trims": ("trim", lambda p: wall_trims(p, "window")),
    "wall-door-trims": ("trim", lambda p: wall_trims(p, "door")),
    "pilaster-trims": ("trim", pilaster_trims),
    "window-frame": ("trim", window_frame),
    "window-sash": ("trim", window_sash),
    "window-glass": ("glass", window_glass),
    "window-glass-broken": ("glass", window_glass_broken),
    "window-grille-bars": ("trim", window_grille_bars),
    "window-grille-sunburst": ("trim", window_grille_sunburst),
    "window-grille-sunburst-lod1": ("trim", lambda p: window_grille_sunburst(p, rays=5, hub_segments=4)),
    "window-sill": ("concrete", window_sill),
    "door-frame": ("trim", door_frame),
    "door": ("props", door),
    "beam": ("concrete", beam),
    "light-fitting": ("props", light_fitting),
    "light-tube": ("tube", light_tube),
    "radiator": ("props", radiator),
    "radiator-lod1": ("props", lambda p: radiator(p, lod=1)),
    "desk": ("props", desk),
    "desk-lod1": ("props", lambda p: desk(p, lod=1)),
    "desk-broken": ("props", lambda p: desk(p, broken=True)),
    "chair": ("props", chair),
    "chair-lod1": ("props", lambda p: chair(p, lod=1)),
    "chair-broken": ("props", lambda p: chair(p, broken=True)),
    "lockers": ("props", lockers),
    "lockers-lod1": ("props", lambda p: lockers(p, lod=1)),
    "teacher-desk": ("props", teacher_desk),
    "blackboard": ("props", blackboard),
    "debris-pile": ("props", debris_pile),
    "fallen-plaster": ("props", fallen_plaster),
    "paper-litter": ("props", paper_litter),
    "bench": ("props", bench),
}


def build(name):
    role, make = PIECES[name]
    piece = Piece(name, role)
    make(piece)
    return piece.finish()


if __name__ == "__main__":
    wanted = globals().get("ASSET_NAME", "interior-kit")
    if wanted in PIECES:
        build(wanted)
    elif wanted == "interior-kit":
        # Every piece in a row along Blender's x, 2.5 m apart, to look at in the renders.
        for i, name in enumerate(PIECES):
            build(name).location.x = i * 2.5
    else:
        raise ValueError(f"no piece named {wanted!r}: pass one of {', '.join(PIECES)} or interior-kit")
