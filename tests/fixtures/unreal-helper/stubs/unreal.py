"""A stand-in for Unreal's `unreal` module, enough to run the Genex editor helper's Python
outside the editor. Every call that would change the editor or the disk is appended to `calls`,
so a test can assert that refused input changed nothing. Names it doesn't define resolve to
empty classes (module __getattr__), so annotations and isinstance checks still work.

The project's assets are `state['registry']` (AssetData rows); `state['classes']` maps a class
path to the Class `load_class` finds; the level's GameMode Override is `state['mode_override']`
and the project's default game mode `state['default_mode']` (a class path).

The play world is flat floors (`state['floors']`, each a Floor) that line traces hit, the pawns
and volumes in `state['actors']`, the player's pawn and its camera manager; every line trace is
appended to `state['traces']`, so a test can assert that refused input never even looked.

A console command is recorded, then handed to `state['on_console']` when a test sets it (a fake
UBT for `Module Recompile`); the editor's log folder is the project's Saved/Logs.

The play world's game clock is `state['game_seconds']` and its last frame's delta
`state['world_delta']`; a test advances them itself. Slate post-tick callbacks are kept in
`state['ticks']` (handle: callback), so a test runs a frame by calling each. The valid key names
are `state['keys']`.

Geometry Script, material and spline calls build plain records: a DynamicMesh's `vertices`, a
Material's `expressions`, a SplineComponent's `points`. Like Unreal's, functions with out-params
answer a tuple (get_all_vertex_positions, create_new_static_mesh_asset_from_mesh,
add_new_subobject), so the helper must pick its value by type.
"""

import math
import types

calls: list[tuple] = []
state: dict = {}


def reset(project_dir: str) -> None:
    """Forgets every call and starts a fresh editor with no play session for the project."""
    calls.clear()
    state.clear()
    state.update({'project': project_dir, 'pie': False, 'actors': [], 'dirs': set(), 'assets': set(),
                  'create_fails': False, 'selected': [], 'floors': [], 'traces': [], 'player': None,
                  'camera': None, 'cvars': {}, 'registry': [], 'classes': {},
                  'mode_override': None, 'default_mode': '', 'dirty': [], 'imports': {}, 'loaded': {},
                  'import_tasks': [], 'game_seconds': 0.0, 'world_delta': 0.0, 'ticks': {},
                  'keys': {'W', 'A', 'S', 'D', 'SpaceBar', 'Gamepad_LeftX'}})


def _record(*call) -> None:
    calls.append(call)


class Object:
    """Base of every stub engine class."""

    @classmethod
    def static_class(cls):
        return Class(cls)

    def get_name(self) -> str:
        return type(self).__name__

    def get_class(self):
        return Class(type(self))

    def set_editor_property(self, name: str, value, notify_mode=None) -> None:
        vars(self).setdefault('props', {})[name] = value


class Class(Object):
    """An engine class reference; a Blueprint's generated class has its object path and its defaults (`cdo`)."""

    def __init__(self, python_class=None, path: str = '', cdo=None) -> None:
        self.python_class = python_class
        self.path, self.cdo = path, cdo

    def get_name(self) -> str:
        if self.path:
            return self.path.rsplit('.', 1)[-1]
        return self.python_class.__name__ if self.python_class else 'Class'

    def get_path_name(self) -> str:
        return self.path or f'/Script/Engine.{self.get_name()}'


class Name(str):
    """FName."""

    def is_none(self) -> bool:
        return self == 'None'


class Text(str):
    """FText."""


class Vector:
    def __init__(self, x: float = 0.0, y: float = 0.0, z: float = 0.0) -> None:
        self.x, self.y, self.z = x, y, z

    def length(self) -> float:
        return math.sqrt(self.x ** 2 + self.y ** 2 + self.z ** 2)


class Rotator:
    def __init__(self, roll: float = 0.0, pitch: float = 0.0, yaw: float = 0.0) -> None:
        self.roll, self.pitch, self.yaw = roll, pitch, yaw


def _axes(rotation: Rotator) -> tuple[tuple, tuple, tuple]:
    """The rotation's forward (X), right (Y) and up (Z) axes, as Unreal's FRotationMatrix makes them."""
    sp, cp = math.sin(math.radians(rotation.pitch)), math.cos(math.radians(rotation.pitch))
    sy, cy = math.sin(math.radians(rotation.yaw)), math.cos(math.radians(rotation.yaw))
    sr, cr = math.sin(math.radians(rotation.roll)), math.cos(math.radians(rotation.roll))
    return ((cp * cy, cp * sy, sp), (sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp),
            (-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp))


def _box_of(points: list[tuple]) -> tuple[Vector, Vector]:
    """The world-axis box around points: (origin, extent)."""
    low = [min(p[i] for p in points) for i in range(3)]
    high = [max(p[i] for p in points) for i in range(3)]
    return (Vector(*[(low[i] + high[i]) / 2 for i in range(3)]), Vector(*[(high[i] - low[i]) / 2 for i in range(3)]))


class World(Object):
    def __init__(self, name: str) -> None:
        self.name = name

    def get_name(self) -> str:
        return self.name

    def get_path_name(self) -> str:
        return f'/Game/Maps/{self.name}.{self.name}'

    def get_world_settings(self):
        return WorldSettings()


class WorldSettings(Object):
    def get_editor_property(self, name: str):
        return {'default_game_mode': state['mode_override']}[name]


class SoftClassPath(Object):
    def __init__(self, path: str) -> None:
        self.path = path

    def export_text(self) -> str:
        return f'"{self.path}"' if self.path else ''


class GameMapsSettings(Object):
    def get_editor_property(self, name: str):
        return {'global_default_game_mode': SoftClassPath(state['default_mode'])}[name]


def load_class(outer, name: str):
    return state['classes'].get(name)


class Actor(Object):
    def __init__(self, label: str = 'Actor', location: Vector | None = None) -> None:
        self.label = label
        self.tags: list[Name] = []
        self.folder = ''
        self.location = location or Vector()
        self.rotation = Rotator()
        self.velocity = Vector()
        self.props: dict = {}
        self.components: list = []
        self.attached: list = []

    def get_actor_label(self) -> str:
        return self.label

    def set_actor_label(self, label: str) -> None:
        _record('set_actor_label', label)
        self.label = label

    def set_folder_path(self, folder: Name) -> None:
        self.folder = str(folder)

    def get_actor_location(self) -> Vector:
        return self.location

    def get_actor_rotation(self) -> Rotator:
        return self.rotation

    def get_velocity(self) -> Vector:
        return self.velocity

    def get_class(self) -> Class:
        return Class(type(self))

    def get_editor_property(self, name: str):
        return self.props.get(name, False)

    def get_component_by_class(self, cls):
        return next((c for c in self.components if isinstance(c, cls)), None)

    def get_components_by_class(self, cls) -> list:
        return [c for c in self.components if isinstance(c, cls)]

    def get_attached_actors(self) -> list:
        return list(self.attached)

    def set_actor_location_and_rotation(self, new_location: Vector, new_rotation: Rotator, sweep: bool = False,
                                        teleport: bool = False) -> None:
        _record('move', self.label, round(new_location.x), round(new_location.y), round(new_location.z),
                round(new_rotation.yaw, 1))
        self.location, self.rotation = new_location, new_rotation

    def set_actor_scale3d(self, new_scale3d: Vector) -> None:
        _record('scale', self.label, new_scale3d.x, new_scale3d.y, new_scale3d.z)
        self.scale = new_scale3d

    def get_actor_bounds(self, only_colliding_components: bool = False, include_from_child_actors: bool = False):
        corners = [corner for c in self.components if isinstance(c, SceneComponent) for corner in c.corners()]
        return _box_of(corners or [(self.location.x, self.location.y, self.location.z)])


class ActorComponent(Object):
    pass


class SceneComponent(ActorComponent):
    """A component placed in the world; `props` answers get_editor_property (False when unset)."""

    def __init__(self, name: str = 'Component', location: Vector | None = None, rotation: Rotator | None = None,
                 scale: Vector | None = None, visible: bool = True, **props) -> None:
        self.name = name
        self.location = location or Vector()
        self.rotation = rotation or Rotator()
        self.scale = scale or Vector(1.0, 1.0, 1.0)
        self.visible = visible
        self.props = props

    def get_name(self) -> str:
        return self.name

    def get_world_location(self) -> Vector:
        return self.location

    def get_world_rotation(self) -> Rotator:
        return self.rotation

    def get_world_scale(self) -> Vector:
        return self.scale

    def is_visible(self) -> bool:
        return self.visible

    def get_editor_property(self, name: str):
        return self.props.get(name, False)

    def corners(self) -> list[tuple]:
        return [(self.location.x, self.location.y, self.location.z)]


class PrimitiveComponent(SceneComponent):
    pass


class ShapeComponent(PrimitiveComponent):
    pass


class CapsuleComponent(ShapeComponent):
    def __init__(self, name: str = 'CollisionCylinder', location: Vector | None = None, half_height: float = 88.0,
                 radius: float = 34.0, **props) -> None:
        super().__init__(name, location, **props)
        self.half_height, self.radius = half_height, radius

    def get_scaled_capsule_half_height(self) -> float:
        return self.half_height

    def corners(self) -> list[tuple]:
        c = self.location
        return [(c.x - self.radius, c.y - self.radius, c.z - self.half_height),
                (c.x + self.radius, c.y + self.radius, c.z + self.half_height)]


class MeshComponent(PrimitiveComponent):
    def set_material(self, element_index: int, material) -> None:
        _record('set_material', self.name, element_index, material)
        self.props.setdefault('materials', {})[element_index] = material

    def set_collision_enabled(self, new_type) -> None:
        _record('set_collision_enabled', self.name, new_type)
        self.props['collision_enabled'] = new_type


class Box:
    def __init__(self, min: Vector, max: Vector) -> None:
        self.min, self.max = min, max


class StaticMesh(Object):
    """A mesh asset with its local bounding box, no material slots and `triangles` in LOD 0."""

    def __init__(self, low: Vector, high: Vector, triangles: int = 1200) -> None:
        self.low, self.high, self.triangles = low, high, triangles

    def get_bounding_box(self) -> Box:
        return Box(self.low, self.high)

    def get_num_triangles(self, lod_index: int) -> int:
        return self.triangles

    def get_num_nanite_triangles(self) -> int:
        return vars(self).get('nanite_triangles', 0)

    def get_path_name(self) -> str:
        path = vars(self).get('path', '/Game/Mesh')
        return f'{path}.{path.rsplit("/", 1)[-1]}'

    def get_editor_property(self, name: str):
        if name == 'body_setup':
            return vars(self).setdefault('body_setup', BodySetup())
        return {'static_materials': []}[name]


class BodySetup(Object):
    """A mesh's collision setup, as set_editor_property leaves it in `props`."""


class MeshNaniteSettings(Object):
    """A mesh's Nanite settings, in `props`."""


class StaticMeshEditorSubsystem:
    def get_nanite_settings(self, static_mesh: StaticMesh) -> MeshNaniteSettings:
        return MeshNaniteSettings()

    def set_nanite_settings(self, static_mesh: StaticMesh, nanite_settings: MeshNaniteSettings, apply_changes: bool) -> None:
        _record('nanite', static_mesh.get_path_name(), nanite_settings.props.get('enabled'))

    def remove_collisions(self, static_mesh: StaticMesh) -> bool:
        _record('remove_collisions', static_mesh.get_path_name())
        return True

    def add_simple_collisions(self, static_mesh: StaticMesh, shape_type) -> int:
        _record('add_simple_collisions', static_mesh.get_path_name(), shape_type.name)
        return 0

    def set_convex_decomposition_collisions(self, static_mesh: StaticMesh, hull_count: int, max_hull_verts: int,
                                            hull_precision: int) -> bool:
        _record('convex_collisions', static_mesh.get_path_name(), hull_count)
        return True


class BoxSphereBounds:
    def __init__(self, origin: Vector, box_extent: Vector) -> None:
        self.origin, self.box_extent = origin, box_extent


def _leaf(path: str) -> str:
    return path.rsplit('/', 1)[-1]


class Skeleton(Object):
    """A skeleton asset, by its path."""

    def __init__(self, path: str = '/Game/Skeleton') -> None:
        self.path = path

    def get_path_name(self) -> str:
        return f'{self.path}.{_leaf(self.path)}'

    def get_name(self) -> str:
        return _leaf(self.path)


class SkeletalMesh(Object):
    """A rigged mesh asset: its path, its skeleton, its reference-pose bounds (`extent`, half sizes in cm)
    and its bones' parents (`parents`, bone: parent, the root's parent None). For the IK Rig and Geometry
    Script stand-ins it also carries the chains auto-characterisation finds (`chains`, name: (start, end)),
    the retarget root (`root`), the reference pose (`reference`, bone: ((x, y, z), quat)) and its LOD 0
    (`vertices`, `triangles`, `weights`: per vertex [(bone, weight)])."""

    def __init__(self, path: str = '/Game/Mesh', extent: Vector | None = None, parents: dict | None = None,
                 skeleton: Skeleton | None = None, chains: dict | None = None, root: str = '',
                 reference: dict | None = None) -> None:
        self.path, self.extent = path, extent or Vector(40.0, 20.0, 90.0)
        self.parents = parents or {}
        self.skeleton = skeleton or Skeleton(f'{path}_Skeleton')
        self.chains, self.root, self.reference = chains or {}, root, reference or {}
        self.vertices: list = []
        self.triangles: list = []
        self.weights: list = []
        self.materials: list = []

    def get_path_name(self) -> str:
        return f'{self.path}.{_leaf(self.path)}'

    def get_name(self) -> str:
        return _leaf(self.path)

    def get_editor_property(self, name: str):
        return {'skeleton': self.skeleton, 'physics_asset': None, 'materials': self.materials}[name]

    def get_bounds(self) -> BoxSphereBounds:
        return BoxSphereBounds(Vector(0.0, 0.0, self.extent.z), self.extent)

    def get_bone_parent(self, bone_name: str) -> Name:
        """Unreal answers the root's (and an unknown bone's) parent as the name None."""
        return Name(self.parents.get(str(bone_name)) or 'None')

    def get_bone_children(self, bone_name: str) -> list:
        return [Name(bone) for bone, parent in self.parents.items() if parent == str(bone_name)]


class AnimSequenceBase(Object):
    """A clip: its path, length, skeleton and `pose_at(seconds)` (bone: ((x, y, z), quat), component space)."""

    def __init__(self, path: str = '/Game/Anim', seconds: float = 1.0, skeleton: Skeleton | None = None,
                 pose_at=None) -> None:
        self.path, self.seconds, self.skeleton = path, seconds, skeleton
        self.pose_at = pose_at or (lambda seconds: {})

    def get_path_name(self) -> str:
        return f'{self.path}.{_leaf(self.path)}'

    def get_play_length(self) -> float:
        return self.seconds

    def get_skeleton(self) -> Skeleton | None:
        return self.skeleton


class AnimSequence(AnimSequenceBase):
    """A clip made by an import or a retarget."""


class SoundWave(Object):
    def __init__(self, duration: float) -> None:
        self.duration = duration

    def get_editor_property(self, name: str):
        return {'duration': self.duration}[name]


class Texture2D(Object):
    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height

    def blueprint_get_size_x(self) -> int:
        return self.width

    def blueprint_get_size_y(self) -> int:
        return self.height


class MaterialInterface(Object):
    """A material or a material instance."""

    def get_base_material(self):
        return None


class MaterialInstanceConstant(MaterialInterface):
    """A material an import made beside its mesh; `parent` is the material it instances."""

    def __init__(self, parent=None) -> None:
        self.parent = parent

    def get_base_material(self):
        return self.parent.get_base_material() if self.parent else None


class SkeletalMaterial(Object):
    """A skeletal mesh's material slot."""

    def __init__(self, material_interface=None) -> None:
        self.material_interface = material_interface

    def get_editor_property(self, name: str):
        return {'material_interface': self.material_interface}[name]


class StaticMeshComponent(MeshComponent):
    """A static mesh placed at location with rotation and scale; its world bounds follow them."""

    def __init__(self, name: str = 'StaticMeshComponent', mesh: StaticMesh | None = None, location: Vector | None = None,
                 rotation: Rotator | None = None, scale: Vector | None = None, visible: bool = True, **props) -> None:
        super().__init__(name, location, rotation, scale, visible, static_mesh=mesh, **props)

    def set_static_mesh(self, new_mesh: StaticMesh) -> bool:
        _record('set_static_mesh', self.name)
        self.props['static_mesh'] = new_mesh
        return True

    def corners(self) -> list[tuple]:
        if self.props.get('static_mesh') is None:
            return super().corners()
        mesh, (fx, rx, ux), c, s = self.props['static_mesh'], _axes(self.rotation), self.location, self.scale
        points = []
        for x in (mesh.low.x, mesh.high.x):
            for y in (mesh.low.y, mesh.high.y):
                for z in (mesh.low.z, mesh.high.z):
                    lx, ly, lz = x * s.x, y * s.y, z * s.z
                    points.append(tuple(getattr(c, a) + lx * fx[i] + ly * rx[i] + lz * ux[i]
                                        for i, a in enumerate('xyz')))
        return points


class SkeletalMeshComponent(MeshComponent):
    """A posed skeletal mesh: its bones' world locations by name; its bounds hold them (or `bounds`)."""

    def __init__(self, name: str = 'SkeletalMeshComponent', bones: dict[str, Vector] | None = None,
                 location: Vector | None = None, visible: bool = True,
                 bounds: tuple[Vector, Vector] | None = None, **props) -> None:
        super().__init__(name, location, None, None, visible, **props)
        self.bones, self.bounds = bones or {}, bounds

    def get_all_socket_names(self) -> list[Name]:
        return [Name(name) for name in self.bones]

    def get_skinned_asset(self):
        return self.props.get('skinned_asset')

    def set_skeletal_mesh_asset(self, new_mesh) -> None:
        _record('skeletal_mesh', new_mesh.get_name())
        self.props['skinned_asset'] = new_mesh

    def set_update_animation_in_editor(self, new_update_state: bool) -> None:
        self.props['update_in_editor'] = new_update_state

    def set_animation_mode(self, animation_mode, force_init_anim_script_instance: bool = True) -> None:
        self.props['animation_mode'] = animation_mode.name

    def set_play_rate(self, rate: float) -> None:
        self.props['play_rate'] = rate

    def set_animation(self, new_anim_to_play) -> None:
        self.props['animation'] = new_anim_to_play

    def set_position(self, pos: float, fire_notifies: bool = True) -> None:
        _record('pose_at', pos)
        self.props['position'] = pos

    def get_socket_location(self, name: str) -> Vector:
        return self.bones[str(name)]

    def corners(self) -> list[tuple]:
        if self.bounds:
            return [(v.x, v.y, v.z) for v in self.bounds]
        return [(v.x, v.y, v.z) for v in self.bones.values()] or super().corners()


class PostProcessSettings(Object):
    """Post-process values by property name; unset overrides read False and unset values 0."""

    def __init__(self, **values) -> None:
        self.values = values

    def get_editor_property(self, name: str):
        return self.values.get(name, False if name.startswith('override_') else 0.0)


class CameraComponent(SceneComponent):
    def __init__(self, name: str = 'FirstPersonCamera', location: Vector | None = None,
                 rotation: Rotator | None = None, **props) -> None:
        props.setdefault('field_of_view', 90.0)
        props.setdefault('post_process_blend_weight', 1.0)
        props.setdefault('post_process_settings', PostProcessSettings())
        super().__init__(name, location, rotation, **props)

    def set_field_of_view(self, in_field_of_view: float) -> None:
        self.props['field_of_view'] = in_field_of_view

    def set_constraint_aspect_ratio(self, in_constrain_aspect_ratio: bool) -> None:
        self.props['constrain_aspect_ratio'] = in_constrain_aspect_ratio


class CharacterMovementComponent(ActorComponent):
    def __init__(self, falling: bool = False) -> None:
        self.falling = falling

    def is_falling(self) -> bool:
        return self.falling


class WheelStatus(Object):
    """Chaos's wheel state: its fields aren't editor properties, so Python reads them only by breaking it."""

    def __init__(self, in_contact: bool) -> None:
        self._in_contact = in_contact

    def get_editor_property(self, name: str):
        raise Exception(f"WheelStatus: Failed to find property '{name}'")


class ChaosWheeledVehicleMovementComponent(ActorComponent):
    def __init__(self, contacts: list[bool]) -> None:
        self.contacts = contacts

    def get_num_wheels(self) -> int:
        return len(self.contacts)

    def get_wheel_state(self, index: int) -> WheelStatus:
        return WheelStatus(self.contacts[index])

    @staticmethod
    def break_wheel_status(status: WheelStatus) -> tuple:
        """Chaos's BreakWheelStatus outputs, in its order: in contact first."""
        return (status._in_contact, Vector(0, 0, 0), None, 0.5, 0.0, 0.0, False, 0.0, False, 0.0, Vector(0, 0, 1),
                0.0, 0.0, False)


class Pawn(Actor):
    pass


class Character(Pawn):
    """A character: a capsule standing at location with its mesh (the capsule's own when not given)."""

    def __init__(self, label: str = 'Character', location: Vector | None = None, mesh: SceneComponent | None = None,
                 half_height: float = 88.0, falling: bool = False) -> None:
        super().__init__(label, location)
        capsule = CapsuleComponent(location=self.location, half_height=half_height)
        self.props['mesh'] = mesh
        self.components = [capsule, CharacterMovementComponent(falling)] + ([mesh] if mesh else [])


class WheeledVehiclePawn(Pawn):
    def __init__(self, label: str = 'Vehicle', location: Vector | None = None, mesh: SceneComponent | None = None,
                 contacts: list[bool] | None = None) -> None:
        super().__init__(label, location)
        self.props['mesh'] = mesh
        self.components = ([mesh] if mesh else []) + [ChaosWheeledVehicleMovementComponent(contacts or [])]


class PostProcessVolume(Actor):
    def __init__(self, label: str, settings: PostProcessSettings, enabled: bool = True, unbound: bool = True,
                 blend_weight: float = 1.0, priority: float = 0.0, box: tuple[Vector, Vector] | None = None) -> None:
        super().__init__(label)
        self.props.update({'settings': settings, 'enabled': enabled, 'unbound': unbound,
                           'blend_weight': blend_weight, 'priority': priority})
        self.box = box

    def get_actor_bounds(self, only_colliding_components: bool = False, include_from_child_actors: bool = False):
        low, high = self.box or (Vector(), Vector())
        return _box_of([(low.x, low.y, low.z), (high.x, high.y, high.z)])


class PlayerCameraManager(Object):
    def __init__(self, location: Vector, rotation: Rotator, fov: float = 90.0, view_target: Actor | None = None) -> None:
        self.location, self.rotation, self.fov, self.view_target = location, rotation, fov, view_target

    def get_camera_location(self) -> Vector:
        return self.location

    def get_camera_rotation(self) -> Rotator:
        return self.rotation

    def get_fov_angle(self) -> float:
        return self.fov


class PlayerController(Object):
    def __init__(self, camera: PlayerCameraManager | None = None) -> None:
        self.camera = camera

    def get_view_target(self) -> Actor | None:
        return self.camera.view_target if self.camera is not None else None

    def get_controlled_pawn(self) -> Actor | None:
        return state['player']


class Floor:
    """A flat floor at height z, of `owner` (an actor or None), over the rectangle (x0, y0, x1, y1) or everywhere."""

    def __init__(self, z: float, owner: Actor | None = None, rect: tuple | None = None) -> None:
        self.z, self.owner, self.rect = z, owner, rect

    def under(self, x: float, y: float) -> bool:
        return self.rect is None or (self.rect[0] <= x <= self.rect[2] and self.rect[1] <= y <= self.rect[3])


class HitResult(Object):
    def __init__(self, point: Vector, actor: Actor | None, start: Vector, end: Vector) -> None:
        self.point, self.actor, self.start, self.end = point, actor, start, end

    def to_tuple(self) -> tuple:
        """Unreal's HitResult breaks through BreakHitResult: its outputs, in its order."""
        return (True, False, 0.0, 0.0, self.point, self.point, Vector(0, 0, 1), Vector(0, 0, 1), None, self.actor,
                None, Name('None'), Name('None'), 0, 0, 0, self.start, self.end)


class TraceTypeQuery:
    TRACE_TYPE_QUERY1 = 'TraceTypeQuery1'


class DrawDebugTrace:
    NONE = 'None'


class _EnumValue:
    def __init__(self, name: str) -> None:
        self.name = name


class FirstPersonPrimitiveType:
    NONE = _EnumValue('NONE')
    FIRST_PERSON = _EnumValue('FIRST_PERSON')
    WORLD_SPACE_REPRESENTATION = _EnumValue('WORLD_SPACE_REPRESENTATION')


class MaterialUsage:
    MATUSAGE_SKELETAL_MESH = _EnumValue('MATUSAGE_SKELETAL_MESH')


def get_default_object(cls):
    return cls.cdo if isinstance(cls, Class) else cls()


class BlueprintStatus:
    BS_UP_TO_DATE = 'BS_UP_TO_DATE'
    BS_UP_TO_DATE_WITH_WARNINGS = 'BS_UP_TO_DATE_WITH_WARNINGS'
    BS_ERROR = 'BS_ERROR'


class Blueprint(Object):
    """A Blueprint that always compiles; its components ([(name, template)]) and member variables
    ({name: the pin type's export text}) are what the editor would list; `generated` is its class."""

    def __init__(self, components: list | None = None, variables: dict[str, str] | None = None,
                 generated: 'Class | None' = None, name: str = '') -> None:
        self.components = components or []
        self.variables = variables or {}
        self.generated, self.name = generated, name

    def get_editor_property(self, name: str):
        return BlueprintStatus.BS_UP_TO_DATE

    def generated_class(self) -> 'Class':
        return self.generated

    def get_name(self) -> str:
        return self.name or super().get_name()

    def get_path_name(self) -> str:
        return self.generated.path if self.generated else ''


class AnimBlueprint(Blueprint):
    """An anim Blueprint: its defaults (`generated.cdo`) hold its variables' values."""


class _Defaults(Object):
    """A generated class's defaults: its variables by name, read and set as editor properties."""

    def __init__(self, **values) -> None:
        self.props = dict(values)

    def get_editor_property(self, name: str):
        return self.props[name]

    def set_editor_property(self, name: str, value, notify_mode=None) -> None:
        _record('set_default', name)
        self.props[name] = value


class EdGraphPinType(Object):
    def __init__(self, text: str) -> None:
        self.text = text

    def export_text(self) -> str:
        return self.text


class SubobjectDataSubsystem:
    """Gathers the Blueprint's actor first, then each component twice (as Unreal lists children); an
    actor in the level (an instance) gathers itself, then its scene components. A handle is
    [variable name, object]; a new one also names its parent's variable (`attach_parent`)."""

    def k2_gather_subobject_data_for_blueprint(self, blueprint: Blueprint) -> list:
        return [('Actor', Actor())] + [handle for handle in blueprint.components for _ in range(2)]

    def k2_gather_subobject_data_for_instance(self, actor: Actor) -> list:
        return [['Actor', actor]] + [[c.get_name(), c] for c in actor.components if isinstance(c, SceneComponent)]

    def k2_find_subobject_data_from_handle(self, handle):
        return handle

    def add_new_subobject(self, params) -> tuple:
        """Like Unreal's: (the new handle, the failure reason as text)."""
        made = params.new_class.python_class
        _record('add_subobject', made.__name__, str(params.parent_handle[0]))
        component = made()
        component.props['attach_parent'] = str(params.parent_handle[0])
        handle = [made.__name__, component]
        if params.blueprint_context is not None:
            params.blueprint_context.components.append(handle)
        else:
            params.parent_handle[1].components.append(component)
        return handle, Text('')

    def rename_subobject(self, handle, new_name) -> bool:
        handle[0] = str(new_name)
        handle[1].name = str(new_name)
        return True


class AddNewSubobjectParams:
    def __init__(self, parent_handle=None, new_class=None, blueprint_context=None) -> None:
        self.parent_handle, self.new_class, self.blueprint_context = parent_handle, new_class, blueprint_context


class SubobjectDataBlueprintFunctionLibrary:
    @staticmethod
    def get_data(handle):
        return handle

    @staticmethod
    def get_object_for_blueprint(data, blueprint):
        return data[1]

    @staticmethod
    def get_variable_name(data) -> Name:
        return Name(data[0])

    @staticmethod
    def get_object(data, even_if_pending_kill: bool = False):
        return data[1]


class TopLevelAssetPath:
    def __init__(self, package_name: str = '', asset_name: str = '') -> None:
        self.package_name, self.asset_name = package_name, asset_name


class AssetData:
    """An asset as the registry lists it, without loading it: its package, name, class and tags."""

    def __init__(self, package_name: str, asset_class: str, tags: dict | None = None, asset=None,
                 fails: bool = False) -> None:
        self.package_name = Name(package_name)
        self.asset_name = Name(package_name.rsplit('/', 1)[-1])
        self.asset_class_path = TopLevelAssetPath('/Script/Engine', asset_class)
        self.tags, self.asset, self.fails = tags or {}, asset, fails

    def get_tag_value(self, tag_name: str):
        return self.tags.get(tag_name)

    def get_asset(self):
        if self.fails:
            raise RuntimeError(f'Failed to load {self.package_name}')
        return self.asset


class AssetRegistry:
    def get_assets_by_class(self, class_path_name: TopLevelAssetPath, search_sub_classes: bool = False) -> list:
        kinds = {class_path_name.asset_name}
        if search_sub_classes and class_path_name.asset_name == 'Blueprint':
            kinds |= {'WidgetBlueprint', 'AnimBlueprint'}
        return [a for a in state['registry'] if a.asset_class_path.asset_name in kinds]


class AssetRegistryHelpers:
    @staticmethod
    def get_asset_registry() -> AssetRegistry:
        return AssetRegistry()


class UserWidget(Object):
    pass


class AnimInstance(Object):
    pass


def uclass():
    return lambda cls: cls


class ToolsetDefinition:
    """Epic's toolset base class."""


def log(message: str) -> None:
    pass


def log_flush() -> None:
    pass


def log_warning(message: str) -> None:
    pass


class ScopedEditorTransaction:
    def __init__(self, description: str) -> None:
        self.description = description

    def __enter__(self):
        _record('transaction', self.description)
        return self

    def __exit__(self, *exc) -> bool:
        return False


class UnrealEditorSubsystem:
    def get_game_world(self):
        return World('PIE_Map') if state['pie'] else None

    def get_editor_world(self):
        return World('Map')

    def get_level_viewport_camera_info(self):
        return Vector(1, 2, 3), Rotator(0, -10, 90)


class LevelEditorSubsystem:
    def save_current_level(self) -> bool:
        _record('save_current_level')
        return True

    def load_level(self, path: str) -> bool:
        _record('load_level', path)
        return True

    def editor_request_end_play(self) -> None:
        _record('end_play')

    def editor_set_viewport_realtime(self, in_realtime: bool, viewport_config_key=None) -> None:
        _record('viewport_realtime', in_realtime)


class EditorActorSubsystem:
    def get_all_level_actors(self) -> list:
        return list(state['actors'])

    def get_selected_level_actors(self) -> list:
        return list(state['selected'])

    def destroy_actor(self, actor: Actor) -> bool:
        _record('destroy_actor', actor.label)
        state['actors'].remove(actor)
        return True

    def spawn_actor_from_object(self, asset, location: Vector, rotation: Rotator = None) -> Actor:
        """A StaticMesh spawns a StaticMeshActor showing it; anything else a plain Actor."""
        _record('spawn', str(asset))
        actor = StaticMeshActor(location=location) if isinstance(asset, StaticMesh) else Actor(location=location)
        if isinstance(asset, StaticMesh):
            actor.static_mesh_component.props['static_mesh'] = asset
        actor.rotation = rotation or Rotator()
        state['actors'].append(actor)
        return actor

    def spawn_actor_from_class(self, actor_class, location: Vector, rotation: Rotator = None) -> Actor:
        """An Actor, PlayerStart or StaticMeshActor class spawns as itself; other classes as a plain Actor."""
        _record('spawn', str(actor_class))
        itself = isinstance(actor_class, type) and (actor_class is Actor or issubclass(actor_class, _SPAWN_AS_ITSELF))
        actor = actor_class(location=location) if itself else Actor(location=location)
        actor.rotation = rotation or Rotator()
        state['actors'].append(actor)
        return actor


_subsystems = {UnrealEditorSubsystem: UnrealEditorSubsystem(), LevelEditorSubsystem: LevelEditorSubsystem(),
               EditorActorSubsystem: EditorActorSubsystem()}


def _static_mesh_editor() -> 'StaticMeshEditorSubsystem':
    return StaticMeshEditorSubsystem()


def get_editor_subsystem(cls):
    if cls is StaticMeshEditorSubsystem:
        return _static_mesh_editor()
    return _subsystems[cls]


def get_engine_subsystem(cls):
    return cls()


class EditorAssetLibrary:
    @staticmethod
    def find_asset_data(path: str):
        return next((a for a in state['registry'] if str(a.package_name) == path), AssetData(path, 'None'))

    @staticmethod
    def does_directory_exist(path: str) -> bool:
        return path in state['dirs']

    @staticmethod
    def does_asset_exist(path: str) -> bool:
        return path in state['assets']

    @staticmethod
    def list_assets(directory_path: str, recursive: bool = True, include_folder: bool = False) -> list[str]:
        return sorted(a for a in state['assets'] if a.startswith(directory_path + '/'))

    @staticmethod
    def save_directory(path: str, only_if_is_dirty: bool = True, recursive: bool = True) -> bool:
        _record('save_directory', path)
        return True

    @staticmethod
    def delete_directory(path: str) -> bool:
        _record('delete_directory', path)
        state['dirs'].discard(path)
        return True

    @staticmethod
    def save_loaded_asset(asset_to_save, only_if_is_dirty: bool = True) -> bool:
        _record('save_asset', asset_to_save.get_name())
        return True


class Package(Object):
    """A content or map package, by its name."""

    def __init__(self, name: str) -> None:
        self.name = name

    def get_name(self) -> str:
        return self.name


class EditorLoadingAndSavingUtils:
    """The unsaved packages are `state['dirty']` (names; a map's has /Maps/); a save that the
    editor refuses (`state['save_refused']`) keeps them."""

    @staticmethod
    def get_dirty_content_packages() -> list:
        return [Package(name) for name in state['dirty'] if '/Maps/' not in name]

    @staticmethod
    def get_dirty_map_packages() -> list:
        return [Package(name) for name in state['dirty'] if '/Maps/' in name]

    @staticmethod
    def save_dirty_packages(save_map_packages: bool, save_content_packages: bool) -> bool:
        _record('save_dirty_packages', save_map_packages, save_content_packages)
        if state.get('save_refused'):
            return False
        state['dirty'] = []
        return True


class Paths:
    @staticmethod
    def project_dir() -> str:
        return state['project'] + '/'

    @staticmethod
    def convert_relative_path_to_full(path: str) -> str:
        return path

    @staticmethod
    def project_log_dir() -> str:
        return state['project'] + '/Saved/Logs/'

    @staticmethod
    def get_project_file_path() -> str:
        return state['project'] + '/' + state['project'].rstrip('/').rsplit('/', 1)[-1] + '.uproject'


class AutomationEditorTask(Object):
    """The screenshot's task: done once the test says so (`state['shot_done']`)."""

    def is_task_done(self) -> bool:
        return state.get('shot_done', True)


class ComparisonTolerance:
    LOW = _EnumValue('LOW')


class AutomationLibrary:
    @staticmethod
    def take_high_res_screenshot(width, height, file, camera=None, mask_enabled=False, capture_hdr=False,
                                 comparison_tolerance=None, comparison_notes='', delay=0.0, force_game_view=False):
        _record('screenshot', width, height, file)
        state.setdefault('screenshots', []).append({'camera': camera, 'delay': delay, 'game_view': force_game_view})
        return AutomationEditorTask()


class AssetImportTask(Object):
    """An import's file, destination and options; Unreal fills imported_object_paths."""
    imported_object_paths: list = []

    def set_editor_property(self, name: str, value, notify_mode=None) -> None:
        setattr(self, name, value)

    def get_editor_property(self, name: str):
        return getattr(self, name)


class InterchangeGenericMeshPipeline(Object):
    """Interchange's mesh options, as set_editor_property leaves them in `props`."""


class InterchangeGenericAnimationPipeline(Object):
    """Interchange's animation options, in `props`."""


class InterchangeGenericCommonSkeletalMeshesAndAnimationsProperties(Object):
    """Interchange's skeleton options, in `props`."""


class InterchangeGenericAssetsPipeline(Object):
    """Interchange's generic pipeline: its mesh, animation and skeleton option objects."""

    def __init__(self) -> None:
        self.props = {'mesh_pipeline': InterchangeGenericMeshPipeline(),
                      'animation_pipeline': InterchangeGenericAnimationPipeline(),
                      'common_skeletal_meshes_and_animations_properties':
                          InterchangeGenericCommonSkeletalMeshesAndAnimationsProperties()}

    def get_editor_property(self, name: str):
        return self.props[name]


class InterchangePipelineStackOverride(Object):
    """The pipelines an import uses instead of the project's."""

    def __init__(self) -> None:
        self.pipelines: list = []

    def add_pipeline(self, pipeline) -> None:
        self.pipelines.append(pipeline)


class AssetTools:
    def import_asset_tasks(self, tasks) -> None:
        """Imports each task's file as `state['imports'][filename]` says: (path, asset) rows, which
        then load and are listed by the registry; every task is kept in `state['import_tasks']`."""
        _record('import', [t.filename for t in tasks])
        for task in tasks:
            state['import_tasks'].append(task)
            made = state['imports'].get(task.filename, [])
            task.imported_object_paths = [f'{path}.{path.rsplit("/", 1)[-1]}' for path, _ in made]
            for path, asset in made:
                if isinstance(asset, Object):
                    asset.path = path
                state['loaded'][path] = asset
                state['assets'].add(path)
                state['registry'].append(AssetData(path, type(asset).__name__, asset=asset))

    def create_asset(self, *args):
        """Records the call; a Material is made (and listed) at <package_path>/<asset_name>, other assets aren't."""
        _record('create_asset', args)
        name, folder, asset_class = args[0], args[1], args[2]
        if asset_class not in (Material, IKRigDefinition, IKRetargeter):
            return None
        made = asset_class(f'{folder}/{name}')
        state['assets'].add(made.path)
        state['loaded'][made.path] = made
        return made


class AssetToolsHelpers:
    @staticmethod
    def get_asset_tools() -> AssetTools:
        return AssetTools()


class MathLibrary:
    @staticmethod
    def class_is_child_of(child: Class, parent: Class) -> bool:
        return issubclass(child.python_class, parent.python_class)


class SystemLibrary:
    @staticmethod
    def get_engine_version() -> str:
        return '5.8.3-0+++UE5+Release-5.8'

    @staticmethod
    def execute_console_command(*args) -> None:
        _record('console', args)
        hook = state.get('on_console')
        if hook:
            hook(args[1])

    @staticmethod
    def raise_script_error(message: str) -> None:
        _record('script_error', message)

    @staticmethod
    def get_console_variable_int_value(name: str) -> int:
        return state['cvars'].get(name, 0)

    @staticmethod
    def get_component_bounds(component: SceneComponent):
        origin, extent = _box_of(component.corners())
        return origin, extent, math.sqrt(extent.x ** 2 + extent.y ** 2 + extent.z ** 2)

    @staticmethod
    def line_trace_single(world_context_object, start: Vector, end: Vector, trace_channel, trace_complex: bool,
                          actors_to_ignore: list, draw_debug_type, ignore_self: bool, *rest):
        """The highest floor under start, between start and end, of no ignored actor; a straight-down trace."""
        state['traces'].append((start.z, end.z))
        ignored = list(actors_to_ignore) + ([world_context_object] if ignore_self else [])
        low, high = min(start.z, end.z), max(start.z, end.z)
        floors = [f for f in state['floors'] if low <= f.z <= high and f.under(start.x, start.y)
                  and not any(f.owner is actor for actor in ignored)]
        if not floors:
            return None
        floor = max(floors, key=lambda f: f.z)
        return HitResult(Vector(start.x, start.y, floor.z), floor.owner, start, end)


class GameplayStatics:
    @staticmethod
    def get_all_actors_of_class(world, cls) -> list:
        return [a for a in state['actors'] if not isinstance(cls, type) or isinstance(a, cls)]

    @staticmethod
    def get_player_controller(world, index):
        has_player = state['camera'] is not None or state['player'] is not None
        return PlayerController(state['camera']) if has_player else None

    @staticmethod
    def get_player_pawn(world, index):
        return state['player']

    @staticmethod
    def get_player_camera_manager(world, index):
        return state['camera']

    @staticmethod
    def get_time_seconds(world_context_object) -> float:
        return state['game_seconds']

    @staticmethod
    def set_game_paused(world_context_object, paused: bool) -> bool:
        state['paused'] = bool(paused)
        return True

    @staticmethod
    def is_game_paused(world_context_object) -> bool:
        return state.get('paused', False)

    @staticmethod
    def get_world_delta_seconds(world_context_object) -> float:
        return state['world_delta']



class BlueprintEditorLibrary:
    @staticmethod
    def compile_blueprint(blueprint) -> None:
        _record('compile', blueprint)

    @staticmethod
    def create_blueprint_asset_with_parent(asset_path: str, parent_class: 'Class') -> Blueprint:
        """A child Blueprint whose components start as the parent's (its defaults' `components`), each its own copy."""
        _record('create_blueprint', asset_path, parent_class.get_name())
        inherited = getattr(parent_class.cdo, 'components', []) if parent_class.cdo is not None else []
        components = [[name, type(template)(name)] for name, template in inherited]
        name = asset_path.rsplit('/', 1)[-1]
        made = Blueprint(components, generated=Class(path=f'{asset_path}.{name}_C', cdo=_Defaults()), name=name)
        state['loaded'][asset_path] = made
        state['assets'].add(asset_path)
        return made

    @staticmethod
    def list_member_variable_names(blueprint: Blueprint, include_inherited_members: bool = True) -> list[str]:
        return list(blueprint.variables)

    @staticmethod
    def get_member_variable_type(blueprint: Blueprint, name: str):
        text = blueprint.variables.get(name)
        return EdGraphPinType(text) if text is not None else None


def register_slate_post_tick_callback(callback):
    handle = object()
    state['ticks'][handle] = callback
    return handle


def unregister_slate_post_tick_callback(handle) -> None:
    state['ticks'].pop(handle, None)


def load_asset(path: str):
    return state['loaded'].get(path)


class InputActionValueType:
    BOOLEAN = _EnumValue('BOOLEAN')
    AXIS1D = _EnumValue('AXIS1D')
    AXIS2D = _EnumValue('AXIS2D')
    AXIS3D = _EnumValue('AXIS3D')


class InputAction(Object):
    """An input action asset: its name and value type."""

    def __init__(self, name: str = 'IA_Action', value_type: _EnumValue = InputActionValueType.AXIS1D) -> None:
        self.name, self.value_type = name, value_type

    def get_name(self) -> str:
        return self.name

    def get_editor_property(self, name: str):
        return {'value_type': self.value_type}[name]


class Key:
    def __init__(self) -> None:
        self.key_name = ''

    def set_editor_property(self, name: str, value, notify_mode=None) -> None:
        setattr(self, name, str(value))

    def get_editor_property(self, name: str):
        return getattr(self, name)


class InputLibrary:
    @staticmethod
    def key_is_valid(key: Key) -> bool:
        return key.key_name in state['keys']


class SplineCoordinateSpace:
    LOCAL = _EnumValue('LOCAL')
    WORLD = _EnumValue('WORLD')


class SplineComponent(PrimitiveComponent):
    """A spline through world points, straight between them (Unreal curves it; the helper only samples it)."""

    def __init__(self, name: str = 'SplineComponent', points: list | None = None, closed: bool = False,
                 **props) -> None:
        super().__init__(name, **props)
        self.points = [Vector(p.x, p.y, p.z) for p in points or []]
        self.closed = closed

    def _legs(self) -> list[tuple]:
        ends = self.points + (self.points[:1] if self.closed else [])
        return list(zip(ends, ends[1:]))

    def get_spline_length(self) -> float:
        return sum(math.dist((a.x, a.y, a.z), (b.x, b.y, b.z)) for a, b in self._legs())

    def is_closed_loop(self) -> bool:
        return self.closed

    def get_number_of_spline_points(self) -> int:
        return len(self.points)

    def get_location_at_distance_along_spline(self, distance: float, coordinate_space) -> Vector:
        left = max(0.0, distance)
        for a, b in self._legs():
            size = math.dist((a.x, a.y, a.z), (b.x, b.y, b.z))
            if left <= size and size > 0:
                t = left / size
                return Vector(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), a.z + t * (b.z - a.z))
            left -= size
        last = self.points[0] if self.closed else self.points[-1]
        return Vector(last.x, last.y, last.z)

    def set_spline_points(self, points: list, coordinate_space, update_spline: bool = True) -> None:
        _record('set_spline_points', len(points), coordinate_space.name)
        self.points = [Vector(p.x, p.y, p.z) for p in points]

    def set_closed_loop(self, in_closed_loop: bool, update_spline: bool = True) -> None:
        _record('set_closed_loop', in_closed_loop)
        self.closed = in_closed_loop


class PlayerStart(Actor):
    pass


class StaticMeshActor(Actor):
    def __init__(self, label: str = 'StaticMeshActor', location: Vector | None = None) -> None:
        super().__init__(label, location)
        self.static_mesh_component = StaticMeshComponent('StaticMeshComponent0', location=self.location)
        self.components = [self.static_mesh_component]


class CameraActor(Actor):
    """A placed camera; its view is its camera component's."""

    def __init__(self, label: str = 'CameraActor', location: Vector | None = None) -> None:
        super().__init__(label, location)
        self.camera_component = CameraComponent('CameraComponent', location=self.location)
        self.components = [self.camera_component]


class SkeletalMeshActor(Actor):
    """A placed skeletal mesh; its mesh, animation and pose are its component's."""

    def __init__(self, label: str = 'SkeletalMeshActor', location: Vector | None = None) -> None:
        super().__init__(label, location)
        self.skeletal_mesh_component = SkeletalMeshComponent('SkeletalMeshComponent', {}, location=self.location)
        self.components = [self.skeletal_mesh_component]


_SPAWN_AS_ITSELF = (PlayerStart, StaticMeshActor, CameraActor, SkeletalMeshActor)


class Transform:
    """A location, rotation (a Rotator as made, or a Quat as an engine call answers it) and scale."""

    def __init__(self, location: Vector | None = None, rotation=None, scale: Vector | None = None) -> None:
        self.location = location or Vector()
        self.rotation = rotation or Rotator()
        self.scale = scale or Vector(1.0, 1.0, 1.0)

    @property
    def translation(self) -> Vector:
        return self.location


class Quat:
    def __init__(self, x: float = 0.0, y: float = 0.0, z: float = 0.0, w: float = 1.0) -> None:
        self.x, self.y, self.z, self.w = x, y, z, w


def _transform(pose: tuple) -> Transform:
    """An engine Transform of a ((x, y, z), (qx, qy, qz, qw)) pose."""
    return Transform(Vector(*pose[0]), Quat(*pose[1]))


class Array(list):
    """unreal.Array: what Unreal hands back for a TArray (not a Python list in the editor)."""


class LinearColor:
    def __init__(self, r: float = 0.0, g: float = 0.0, b: float = 0.0, a: float = 1.0) -> None:
        self.r, self.g, self.b, self.a = r, g, b, a


class ScriptCollisionShapeType:
    BOX = _EnumValue('BOX')


class InterchangeCombineStaticMeshesBehavior:
    ALL = _EnumValue('ALL')


class CollisionEnabled:
    NO_COLLISION = _EnumValue('NO_COLLISION')
    QUERY_AND_PHYSICS = _EnumValue('QUERY_AND_PHYSICS')


class CollisionTraceFlag:
    CTF_USE_DEFAULT = _EnumValue('CTF_USE_DEFAULT')
    CTF_USE_COMPLEX_AS_SIMPLE = _EnumValue('CTF_USE_COMPLEX_AS_SIMPLE')


class GeometryScriptPrimitiveOptions:
    def __init__(self, **props) -> None:
        self.props = props


class GeometryScriptCalculateNormalsOptions:
    def __init__(self, **props) -> None:
        self.props = props


class GeometryScriptMeshSelection:
    def __init__(self, **props) -> None:
        self.props = props


class GeometryScriptCreateNewStaticMeshAssetOptions:
    def __init__(self, **props) -> None:
        self.props = props


class GeometryScriptVectorList:
    def __init__(self, vectors: list | None = None) -> None:
        self.vectors = list(vectors or [])


class DynamicMesh(Object):
    """A mesh being built: its vertices, in order."""

    def __init__(self) -> None:
        self.vertices: list[Vector] = []


class GeometryScript_Primitives:
    @staticmethod
    def append_rectangle_xy(target_mesh: DynamicMesh, primitive_options, transform: Transform,
                            dimension_x: float = 100.0, dimension_y: float = 100.0, steps_width: int = 0,
                            steps_height: int = 0, debug=None) -> DynamicMesh:
        """A flat grid of (steps_width + 1) x (steps_height + 1) vertices centred on the transform's location."""
        _record('append_rectangle_xy', round(dimension_x), round(dimension_y), steps_width, steps_height)
        cx, cy, cz = transform.location.x, transform.location.y, transform.location.z
        for j in range(steps_height + 1):
            for i in range(steps_width + 1):
                target_mesh.vertices.append(Vector(cx - dimension_x / 2 + i * dimension_x / steps_width,
                                                   cy - dimension_y / 2 + j * dimension_y / steps_height, cz))
        return target_mesh


class GeometryScript_MeshQueries:
    @staticmethod
    def get_all_vertex_positions(target_mesh: DynamicMesh, skip_gaps: bool = False) -> tuple:
        """Like Unreal's: the mesh, then its out-params (the positions, whether ids have gaps)."""
        return target_mesh, GeometryScriptVectorList(target_mesh.vertices), False

    @staticmethod
    def get_all_triangle_indices(target_mesh: DynamicMesh, skip_gaps: bool = False) -> tuple:
        return target_mesh, GeometryScriptTriangleList(target_mesh.triangles), False


class GeometryScript_List:
    @staticmethod
    def convert_triangle_list_to_array(triangle_list: 'GeometryScriptTriangleList') -> Array:
        return Array(IntVector(*t) for t in triangle_list.triangles)

    @staticmethod
    def convert_vector_list_to_array(vector_list: GeometryScriptVectorList) -> Array:
        return Array(vector_list.vectors)

    @staticmethod
    def convert_array_to_vector_list(vector_array: list) -> GeometryScriptVectorList:
        return GeometryScriptVectorList(vector_array)


class GeometryScript_MeshEdits:
    @staticmethod
    def set_all_mesh_vertex_positions(target_mesh: DynamicMesh, position_list: GeometryScriptVectorList,
                                      debug=None) -> DynamicMesh:
        _record('set_all_mesh_vertex_positions', len(position_list.vectors))
        target_mesh.vertices = list(position_list.vectors)
        return target_mesh


class GeometryScript_Normals:
    @staticmethod
    def recompute_normals(target_mesh: DynamicMesh, calculate_options, deferred: bool = False,
                          debug=None) -> DynamicMesh:
        _record('recompute_normals')
        return target_mesh


class GeometryScript_UVs:
    @staticmethod
    def set_mesh_u_vs_from_planar_projection(target_mesh: DynamicMesh, uv_set_index: int, plane_transform: Transform,
                                             selection, debug=None) -> DynamicMesh:
        _record('set_mesh_u_vs_from_planar_projection', uv_set_index)
        return target_mesh


class GeometryScript_NewAssetUtils:
    @staticmethod
    def create_new_static_mesh_asset_from_mesh(from_dynamic_mesh: DynamicMesh, asset_path_and_name: str, options,
                                               debug=None) -> tuple:
        """Like Unreal's: (the new StaticMesh or None, the outcome). It fails when `state['mesh_asset_fails']`."""
        _record('create_new_static_mesh_asset_from_mesh', asset_path_and_name, dict(options.props))
        if state.get('mesh_asset_fails'):
            return None, 'Failure'
        points = [(v.x, v.y, v.z) for v in from_dynamic_mesh.vertices] or [(0.0, 0.0, 0.0)]
        low, high = _box_of(points)
        made = StaticMesh(Vector(low.x - high.x, low.y - high.y, low.z - high.z),
                          Vector(low.x + high.x, low.y + high.y, low.z + high.z), 2 * len(points))
        made.vertices = list(from_dynamic_mesh.vertices)
        state['assets'].add(asset_path_and_name)
        state['loaded'][asset_path_and_name] = made
        return made, 'Success'


class Material(MaterialInterface):
    """A material asset: its expressions, links and properties as the editing library leaves them."""

    def __init__(self, path: str = '') -> None:
        self.path = path
        self.expressions: list = []
        self.links: list[tuple] = []
        self.usages: set = set()

    def get_name(self) -> str:
        return self.path.rsplit('/', 1)[-1]

    def get_path_name(self) -> str:
        return f'{self.path}.{self.get_name()}'

    def get_base_material(self):
        return self


class MaterialFactoryNew(Object):
    pass


class MaterialExpression(Object):
    def __init__(self) -> None:
        self.material = None


class MaterialExpressionWorldPosition(MaterialExpression):
    pass


class MaterialExpressionNoise(MaterialExpression):
    pass


class MaterialExpressionMultiply(MaterialExpression):
    pass


class MaterialExpressionLinearInterpolate(MaterialExpression):
    pass


class MaterialExpressionConstant(MaterialExpression):
    pass


class MaterialExpressionConstant3Vector(MaterialExpression):
    pass


class MaterialProperty:
    MP_BASE_COLOR = _EnumValue('MP_BASE_COLOR')
    MP_ROUGHNESS = _EnumValue('MP_ROUGHNESS')


class MaterialEditingLibrary:
    """Records what a material is made of on the Material: its expressions and (from, output, to, input) links."""

    @staticmethod
    def create_material_expression(material: Material, expression_class, node_pos_x: int = 0,
                                   node_pos_y: int = 0) -> MaterialExpression:
        _record('create_material_expression', material.path, expression_class.__name__)
        made = expression_class()
        made.material = material
        material.expressions.append(made)
        return made

    @staticmethod
    def connect_material_expressions(from_expression: MaterialExpression, from_output_name: str,
                                     to_expression: MaterialExpression, to_input_name: str) -> bool:
        from_expression.material.links.append((from_expression, from_output_name, to_expression, to_input_name))
        return True

    @staticmethod
    def connect_material_property(from_expression: MaterialExpression, from_output_name: str, property_) -> bool:
        from_expression.material.links.append((from_expression, from_output_name, property_.name, ''))
        return True

    @staticmethod
    def delete_all_material_expressions(material: Material) -> None:
        _record('delete_all_material_expressions', material.path)
        material.expressions.clear()
        material.links.clear()

    @staticmethod
    def recompile_material(material: Material) -> None:
        _record('recompile_material', material.path)

    @staticmethod
    def has_material_usage(material: Material, usage) -> bool:
        return usage.name in material.usages

    @staticmethod
    def set_material_usage(material: Material, usage) -> bool:
        """Marks the usage; True when the material needs a recompile for it."""
        _record('set_material_usage', material.path, usage.name)
        added = usage.name not in material.usages
        material.usages.add(usage.name)
        return added


def new_object(type, outer=None, name='None', base_type=None):
    return type()


class BoneChain(Object):
    def __init__(self, chain_name: str) -> None:
        self.chain_name = Name(chain_name)

    def get_editor_property(self, name: str):
        return {'chain_name': self.chain_name}[name]


class IKRigDefinition(Object):
    """An IK Rig, as its controller leaves it: the mesh, chains, root and solvers."""

    def __init__(self, path: str = '') -> None:
        self.path, self.mesh, self.chains, self.root, self.solvers = path, None, {}, '', 0

    def get_path_name(self) -> str:
        return f'{self.path}.{_leaf(self.path)}'


class IKRigDefinitionFactory(Object):
    pass


class IKRigController:
    """An IK Rig's controller: auto-characterisation reads the mesh's `chains` and `root`, the reference
    pose its `reference`; apply_auto_fbik adds one solver when the mesh has chains (`state['fbik_fails']` refuses)."""

    def __init__(self, rig: IKRigDefinition) -> None:
        self.rig = rig

    @staticmethod
    def get_controller(in_ik_rig_definition: IKRigDefinition) -> 'IKRigController':
        return IKRigController(in_ik_rig_definition)

    def set_skeletal_mesh(self, skeletal_mesh: SkeletalMesh) -> bool:
        self.rig.mesh = skeletal_mesh
        return True

    def apply_auto_generated_retarget_definition(self) -> bool:
        self.rig.chains, self.rig.root = dict(self.rig.mesh.chains), self.rig.mesh.root
        return bool(self.rig.chains)

    def apply_auto_fbik(self) -> bool:
        if state.get('fbik_fails') or not self.rig.chains:
            return False
        _record('apply_auto_fbik', self.rig.mesh.get_name())
        self.rig.solvers = 1
        return True

    def get_num_solvers(self) -> int:
        return self.rig.solvers

    def get_retarget_chains(self) -> list:
        return [BoneChain(name) for name in self.rig.chains]

    def get_retarget_chain_start_bone(self, chain_name: str) -> Name:
        return Name(self.rig.chains[str(chain_name)][0])

    def get_retarget_chain_end_bone(self, chain_name: str) -> Name:
        return Name(self.rig.chains[str(chain_name)][1])

    def get_retarget_root(self) -> Name:
        return Name(self.rig.root)

    def set_retarget_chain_start_bone(self, chain_name: str, start_bone_name: str) -> bool:
        _record('chain_start', self.rig.mesh.get_name(), str(chain_name), str(start_bone_name))
        name = str(chain_name)
        self.rig.chains[name] = (str(start_bone_name), self.rig.chains[name][1])
        return True

    def get_ref_pose_transform_of_bone(self, bone_name: str) -> 'Transform':
        return _transform(self.rig.mesh.reference[str(bone_name)])


class RetargetSourceOrTarget:
    SOURCE = _EnumValue('SOURCE')
    TARGET = _EnumValue('TARGET')


class AutoMapChainType:
    EXACT = _EnumValue('EXACT')
    FUZZY = _EnumValue('FUZZY')


class FKChainRotationMode:
    INTERPOLATED = _EnumValue('INTERPOLATED')
    ONE_TO_ONE = _EnumValue('ONE_TO_ONE')


class _ChainSettings(Object):
    """A struct of settings by name, read and written with get/set_editor_property."""

    def __init__(self, **props) -> None:
        self.props = props

    def get_editor_property(self, name: str):
        return self.props[name]

    def copied(self) -> '_ChainSettings':
        return type(self)(**{k: [c.copied() for c in v] if isinstance(v, list) else v for k, v in self.props.items()})


class RetargetFKChainSettings(_ChainSettings):
    pass


class IKRetargetFKChainsOpSettings(_ChainSettings):
    pass


class IKRetargetRunIKRigChainSettings(_ChainSettings):
    pass


class IKRetargetRunIKRigOpSettings(_ChainSettings):
    pass


class RetargetAutoAlignMethod:
    CHAIN_TO_CHAIN = _EnumValue('CHAIN_TO_CHAIN')


class IKRetargeter(Object):
    """A retargeter, as its controller leaves it: rigs by side, its op stack (names) and the retarget poses'
    local rotation offsets (`offsets`, side name: {bone: Quat})."""

    def __init__(self, path: str = '') -> None:
        self.path, self.rigs, self.ops = path, {}, []
        self.offsets: dict = {'SOURCE': {}, 'TARGET': {}}
        self.op_controllers: dict = {}

    def get_path_name(self) -> str:
        return f'{self.path}.{_leaf(self.path)}'

    def get_name(self) -> str:
        return _leaf(self.path) if self.path else super().get_name()


class IKRetargetFactory(Object):
    pass


class IKRetargetOpControllerBase(Object):
    """An op's controller; an op with settings answers a copy from get_settings and stores one with set_settings."""

    def __init__(self, settings: _ChainSettings | None = None) -> None:
        self.settings = settings


class IKRetargetFKChainsController(IKRetargetOpControllerBase):
    def get_settings(self) -> _ChainSettings:
        return self.settings.copied()

    def set_settings(self, in_settings: _ChainSettings) -> None:
        self.settings = in_settings.copied()


class IKRetargetRunIKRigController(IKRetargetOpControllerBase):
    def get_settings(self) -> _ChainSettings:
        return self.settings.copied()

    def set_settings(self, in_settings: _ChainSettings) -> None:
        self.settings = in_settings.copied()


DEFAULT_OPS = ('PelvisMotion', 'FKChains', 'RunIKRig', 'RootMotion')


class IKRetargeterController:
    def __init__(self, asset: IKRetargeter) -> None:
        self.asset = asset

    @staticmethod
    def get_controller(in_retargeter_asset: IKRetargeter) -> 'IKRetargeterController':
        return IKRetargeterController(in_retargeter_asset)

    def set_ik_rig(self, source_or_target, ik_rig: IKRigDefinition) -> None:
        self.asset.rigs[source_or_target.name] = ik_rig

    def set_preview_mesh(self, source_or_target, in_preview_mesh) -> None:
        self.asset.rigs[f'{source_or_target.name}_mesh'] = in_preview_mesh

    def remove_all_ops(self) -> bool:
        _record('remove_all_ops')
        had = bool(self.asset.ops)
        self.asset.ops, self.asset.op_controllers = [], {}
        return had

    def get_current_retarget_pose_name(self, source_or_target) -> Name:
        return Name('Default Pose')

    def reset_retarget_pose(self, pose_to_reset: str, bones_to_reset: list, source_or_target) -> None:
        _record('reset_retarget_pose', str(pose_to_reset), source_or_target.name)
        self.asset.offsets[source_or_target.name] = {}

    def auto_align_bones(self, bones_to_align: list, method, source_or_target) -> None:
        _record('auto_align_bones', tuple(str(b) for b in bones_to_align), source_or_target.name)

    def add_default_ops(self) -> None:
        _record('add_default_ops')
        self.asset.ops += [op for op in state.get('default_ops', DEFAULT_OPS) if op not in self.asset.ops]

    def add_retarget_op(self, in_ik_retarget_op_type: str) -> int:
        _record('add_retarget_op', in_ik_retarget_op_type)
        self.asset.ops.append(in_ik_retarget_op_type.rsplit('.', 1)[-1].replace('IKRetarget', '').replace('Op', ''))
        return len(self.asset.ops) - 1

    def get_num_retarget_ops(self) -> int:
        return len(self.asset.ops)

    def get_op_controller(self, in_op_index: int):
        """FK Chains and Run IK Rig hold a setting per chain of the target rig; other ops have none."""
        op = self.asset.ops[in_op_index]
        if op not in self.asset.op_controllers:
            chains = list(self.asset.rigs['TARGET'].chains) if 'TARGET' in self.asset.rigs else []
            if op == 'FKChains':
                rows = [RetargetFKChainSettings(target_chain_name=Name(c), rotation_mode=FKChainRotationMode.INTERPOLATED)
                        for c in chains]
                made = IKRetargetFKChainsController(IKRetargetFKChainsOpSettings(chains_to_retarget=rows))
            elif op == 'RunIKRig':
                rows = [IKRetargetRunIKRigChainSettings(target_chain_name=Name(c), enable_ik=True) for c in chains]
                made = IKRetargetRunIKRigController(IKRetargetRunIKRigOpSettings(chains=rows))
            else:
                made = IKRetargetOpControllerBase()
            self.asset.op_controllers[op] = made
        return self.asset.op_controllers[op]

    def assign_ik_rig_to_all_ops(self, in_source_or_target, in_ik_rig: IKRigDefinition) -> None:
        _record('assign_ik_rig_to_all_ops', in_source_or_target.name)

    def auto_map_chains(self, auto_map_type, force_remap: bool, op_name: str = 'None') -> None:
        _record('auto_map_chains', auto_map_type.name, force_remap)

    def auto_align_all_bones(self, source_or_target, method=None) -> None:
        _record('auto_align_all_bones', source_or_target.name, method.name if method else None)

    def get_rotation_offset_for_retarget_pose_bone(self, bone_name: str, source_or_target) -> 'Quat':
        return self.asset.offsets[source_or_target.name].get(str(bone_name), Quat())

    def set_rotation_offset_for_retarget_pose_bone(self, bone_name: str, rotation_offset: 'Quat', skeleton_mode) -> None:
        _record('rotation_offset', str(bone_name), skeleton_mode.name)
        self.asset.offsets[skeleton_mode.name][str(bone_name)] = rotation_offset


class IKRetargetBatchOperationInputs(Object):
    pass


class IKRetargetBatchOperation:
    @staticmethod
    def run_batch_retarget(inputs: IKRetargetBatchOperationInputs) -> list:
        """One new clip per asset to retarget, named with the suffix in the target path, on the target's skeleton;
        its pose at t is `state['retargeted'](t)` (the target's reference pose without one)."""
        props = inputs.props
        _record('run_batch_retarget', props['target_path'])
        state['batch_inputs'] = props
        made = []
        for source in props['assets_to_retarget']:
            path = f"{props['target_path']}/{_leaf(str(source.package_name))}{props['suffix']}"
            mesh = props['target_mesh']
            state['loaded'][path] = AnimSequence(path, 1.0, mesh.skeleton, state.get('retargeted', lambda t: mesh.reference))
            made.append(AssetData(path, 'AnimSequence'))
        return made


class AnimPoseSpaces:
    LOCAL = _EnumValue('LOCAL')
    WORLD = _EnumValue('WORLD')


class AnimPoseEvaluationOptions(Object):
    pass


class AnimPose(Object):
    def __init__(self, bones: dict) -> None:
        self.bones = bones


class AnimPoseExtensions:
    @staticmethod
    def get_anim_pose_at_time(animation_sequence_base: AnimSequenceBase, time: float, evaluation_options):
        return AnimPose(animation_sequence_base.pose_at(time))

    @staticmethod
    def get_bone_pose(pose: AnimPose, bone_name: str, space=None) -> 'Transform':
        return _transform(pose.bones[str(bone_name)])


class AnimationMode:
    ANIMATION_BLUEPRINT = _EnumValue('ANIMATION_BLUEPRINT')
    ANIMATION_SINGLE_NODE = _EnumValue('ANIMATION_SINGLE_NODE')


class VisibilityBasedAnimTickOption:
    ALWAYS_TICK_POSE_AND_REFRESH_BONES = _EnumValue('ALWAYS_TICK_POSE_AND_REFRESH_BONES')


class IntVector:
    def __init__(self, x: int = 0, y: int = 0, z: int = 0) -> None:
        self.x, self.y, self.z = x, y, z


class GeometryScriptTriangleList:
    def __init__(self, triangles: list | None = None) -> None:
        self.triangles = list(triangles or [])


class GeometryScriptCopyMeshFromAssetOptions:
    def __init__(self, **props) -> None:
        self.props = props


class GeometryScriptMeshReadLOD:
    def __init__(self, **props) -> None:
        self.props = props


class GeometryScriptBoneInfo:
    def __init__(self, index: int, name: str) -> None:
        self.index, self.name = index, Name(name)


class GeometryScriptBoneWeight:
    def __init__(self, bone_index: int, weight: float) -> None:
        self.bone_index, self.weight = bone_index, weight


class GeometryScript_AssetUtils:
    @staticmethod
    def copy_mesh_from_skeletal_mesh(from_skeletal_mesh_asset: SkeletalMesh, to_dynamic_mesh, asset_options,
                                     requested_lod, debug=None) -> tuple:
        mesh = from_skeletal_mesh_asset
        to_dynamic_mesh.vertices = [Vector(*v) for v in mesh.vertices]
        to_dynamic_mesh.triangles, to_dynamic_mesh.weights = list(mesh.triangles), list(mesh.weights)
        to_dynamic_mesh.bones = sorted({bone for influences in mesh.weights for bone, _ in influences})
        return to_dynamic_mesh, _EnumValue('SUCCESS')


class GeometryScript_BoneWeights:
    @staticmethod
    def get_all_bones_info(target_mesh, debug=None) -> tuple:
        return target_mesh, Array(GeometryScriptBoneInfo(i, name) for i, name in enumerate(target_mesh.bones))

    @staticmethod
    def get_vertex_bone_weights(target_mesh, vertex_id: int, profile=None) -> tuple:
        index = {name: i for i, name in enumerate(target_mesh.bones)}
        weights = Array(GeometryScriptBoneWeight(index[bone], weight) for bone, weight in target_mesh.weights[vertex_id])
        return target_mesh, weights, bool(weights)


def __getattr__(name: str):
    if name.startswith('__'):
        raise AttributeError(name)
    made = types.new_class(name, (Object,))
    globals()[name] = made
    return made
