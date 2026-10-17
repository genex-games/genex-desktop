"""`gx`: the library a build script gets beside `unreal` and `args` (run_script runs
unreal/build/<file>.py with all three; `import gx` works too). Positions are (x, y, z) in cm,
rotations (pitch, yaw, roll) in degrees. Every actor a script makes belongs to its scope, so running
the script again first removes what it made last time: one copy, never two.

    gx.scope(name)                  remove what scope `name` made before; later actors are its (the
                                    script opens a scope named after itself first: zones/shaft.py
                                    is "zones/shaft"); `with gx.scope("x"):` gives the old one back
    gx.spawn_mesh(mesh, location, rotation=None, scale=None, label=None, material=None, collision=True)
    gx.instances(mesh, transforms, label=None, material=None, collision=True, cull_m=0)
                                    ONE actor drawing the mesh at every transform ((x, y, z), or
                                    (location, rotation[, scale])): repeat modules with this, never
                                    an actor per copy
    gx.kit_module(kind, name, size, bevel_cm=2, path=None)
                                    a Nanite kit piece SM_<name> in /Game/GX/Kit: slab, rib, girder,
                                    stairs, pipe (size (x, y, z) cm; a pipe follows `path` if given)
    gx.world_material(kind, name=None, **params)
                                    world-aligned concrete, steel, grime or emissive (instance MI_<name>)
    gx.atmosphere(preset, **overrides)
                                    replace the template sky with "megastructure" or "daylight" light,
                                    volumetric fog, manual exposure and grade
    gx.local_fog(location, radius_m=30, density=0.5, color=(r, g, b))
    gx.light(kind, location, rotation=None, intensity=10, color=None, kelvin=None, radius_m=10,
             volumetric=1, shadows=True, label=None)        point, spot or rect
    gx.shot_camera(name, location, rotation, fov=60)        hero camera GX_Shot_<name>
    gx.attach_to_socket(target, mesh, socket, offset=None)  Blueprint path or actor label
    gx.import_model(file, dest, name, collision="box", nanite=True)
    gx.import_character(file, dest, name)
    gx.import_animation(file, skeleton, dest, name)
    gx.import_sound(file, dest, name)
    gx.retarget(source_mesh, target_mesh, animations, dest)
    gx.audit(camera="")             counts: actors, instances, triangles, primitives (in view)
    gx.actors(scope)                the level actors a scope made
    gx.vector / gx.rotator / gx.transform   unreal values from plain tuples

A mesh or material is an asset or its /Game/ path. Set `result` in the script to answer data.
"""

from genex_build import atmosphere as _atmosphere
from genex_build import audit as _audit
from genex_build import imports as _imports
from genex_build import kit as _kit
from genex_build import place as _place
from genex_build import retarget as _retarget
from genex_build import scope as _scope
from genex_build import sockets as _sockets
from genex_build import world_materials as _materials

scope = _scope.scope
actors = _scope.scope_actors
spawn_mesh = _place.spawn_mesh
instances = _place.instances
light = _place.light
shot_camera = _place.shot_camera
vector = _place.vector
rotator = _place.rotator
transform = _place.transform
kit_module = _kit.kit_module
world_material = _materials.world_material
atmosphere = _atmosphere.atmosphere
local_fog = _atmosphere.local_fog
attach_to_socket = _sockets.attach_to_socket
import_character = _imports.import_character
import_animation = _imports.import_animation
import_sound = _imports.import_sound
retarget = _retarget.retarget
audit = _audit.audit


def import_model(file, dest, name, collision='box', nanite=True):
    """One static mesh from a model file of the game's assets; see genex_build.imports."""
    return _imports.import_model(file, dest, name, collision, nanite)
