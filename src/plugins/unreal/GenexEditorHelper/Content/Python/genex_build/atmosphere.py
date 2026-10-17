"""gx.atmosphere(preset): the light, air and grade of the whole level in one call. It removes the
template's sky (sky atmosphere or the old sky sphere), sun, sky light, fog, clouds and unbound
post-process volumes, then makes its own,
tagged gx:atmosphere (calling it again replaces them):

    a directional key light (light shafts, volumetric shadow), a sky light, a sky atmosphere, an
    exponential height fog with volumetric fog, local fog volumes, and an unbound post-process volume
    with MANUAL exposure (the image never pumps: tune lights, not exposure), bloom, vignette, film
    grain, saturation, contrast and a cool shadow tint.

Presets:
    megastructure   a cold key falling almost straight down, dense blue-grey volumetric haze that
                    makes every opening a shaft, a dim sky, deep blacks, near-monochrome grade
    daylight        a warm afternoon sun, a clear sky, light haze for depth, neutral grade

Any preset value can be overridden by keyword: gx.atmosphere('megastructure', sun_pitch=-70,
exposure=1.5, fog_density=0.06). gx.local_fog adds a pocket of fog of the scene's own.
"""

import math
from typing import NamedTuple

import unreal

from genex_build import place, scope
from genex_loop import editor
from genex_loop.errors import Refused


class Preset(NamedTuple):
    """One atmosphere's numbers: angles in degrees, light in its own units (lux for the sun), fog per Unreal."""
    sun_pitch: float
    sun_yaw: float
    sun_lux: float
    sun_kelvin: float
    sun_angle: float
    sun_volumetric: float
    sky_intensity: float
    sky_tint: tuple
    sky_luminance: float
    fog_density: float
    fog_falloff: float
    fog_color: tuple
    fog_scatter: float
    fog_albedo: float
    fog_extinction: float
    fog_view_m: float
    fog_height: float
    exposure: float
    bloom: float
    vignette: float
    grain: float
    saturation: float
    contrast: float
    shadow_tint: tuple
    local_fogs: tuple


PRESETS = {
    'megastructure': Preset(
        sun_pitch=-80.0, sun_yaw=35.0, sun_lux=12.0, sun_kelvin=7200.0, sun_angle=0.4, sun_volumetric=4.0,
        sky_intensity=0.04, sky_tint=(0.55, 0.65, 0.8), sky_luminance=0.04,
        fog_density=0.045, fog_falloff=0.035, fog_color=(0.2, 0.22, 0.26), fog_scatter=0.7, fog_albedo=0.85,
        fog_extinction=1.5, fog_view_m=250.0, fog_height=-500.0,
        exposure=-0.3, bloom=0.8, vignette=0.35, grain=0.15, saturation=0.85, contrast=1.3,
        shadow_tint=(0.9, 0.97, 1.08), local_fogs=((0.0, 0.0, -400.0, 40.0), (3000.0, -2000.0, -200.0, 25.0))),
    'daylight': Preset(
        sun_pitch=-38.0, sun_yaw=-55.0, sun_lux=10.0, sun_kelvin=5600.0, sun_angle=0.6, sun_volumetric=1.0,
        sky_intensity=1.0, sky_tint=(1.0, 1.0, 1.0), sky_luminance=1.0,
        fog_density=0.012, fog_falloff=0.12, fog_color=(0.55, 0.62, 0.72), fog_scatter=0.4, fog_albedo=0.9,
        fog_extinction=1.0, fog_view_m=400.0, fog_height=0.0,
        exposure=0.0, bloom=0.5, vignette=0.25, grain=0.05, saturation=1.0, contrast=1.05,
        shadow_tint=(0.97, 0.99, 1.03), local_fogs=()),
}
# The classes of the template's sky, sun and air, which an atmosphere replaces.
REPLACED = ('DirectionalLight', 'SkyLight', 'SkyAtmosphere', 'ExponentialHeightFog', 'VolumetricCloud')
CM_PER_M = 100.0
# The engine's old sky sphere Blueprint draws a mesh from here; an atmosphere replaces it too.
SKY_SPHERE_MESHES = '/Engine/EngineSky/'

MESSAGE = {
    'preset': f'preset must be one of {", ".join(PRESETS)}.',
    'override': 'atmosphere takes overrides of a preset\'s own values: {names}; it has no {name}.',
    'number': '{name} must be a finite number.',
}


def resolve(preset: object, overrides: dict) -> Preset:
    """The preset with overrides applied, or Refused; nothing in the editor changes."""
    if preset not in PRESETS:
        raise Refused(MESSAGE['preset'], preset=preset)
    base = PRESETS[preset]
    for name, value in overrides.items():
        if name not in Preset._fields:
            raise Refused(MESSAGE['override'].format(names=', '.join(Preset._fields), name=name))
        if not isinstance(getattr(base, name), (tuple,)):
            ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            if not ok:
                raise Refused(MESSAGE['number'].format(name=name), **{name: repr(value)[:40]})
    return base._replace(**overrides)


def _linear(rgb: tuple) -> unreal.LinearColor:
    return unreal.LinearColor(r=float(rgb[0]), g=float(rgb[1]), b=float(rgb[2]), a=1.0)


def _replaced_actors() -> list:
    """The level's sky, sun, sky light, fog, clouds and unbound post-process volumes not made by an atmosphere."""
    classes = tuple(cls for cls in (unreal.load_class(None, f'/Script/Engine.{name}') for name in REPLACED) if cls)
    found = []
    ours = scope.tag_of(scope.ATMOSPHERE_SCOPE)
    for actor in editor.actors().get_all_level_actors():
        if ours in actor.tags:
            continue
        if any(actor.get_class() == cls or unreal.MathLibrary.class_is_child_of(actor.get_class(), cls) for cls in classes):
            found.append(actor)
        elif isinstance(actor, unreal.PostProcessVolume) and actor.get_editor_property('unbound'):
            found.append(actor)
        elif _is_sky_sphere(actor):
            found.append(actor)
    return found


def _is_sky_sphere(actor) -> bool:
    """Whether an actor is the engine's old sky sphere (its mesh is one of /Engine/EngineSky/)."""
    for component in actor.get_components_by_class(unreal.StaticMeshComponent):
        mesh = component.get_editor_property('static_mesh')
        if mesh is not None and mesh.get_path_name().startswith(SKY_SPHERE_MESHES):
            return True
    return False


def _spawn(class_name: str, location=(0.0, 0.0, 0.0), rotation=None, label: str = ''):
    cls = unreal.load_class(None, f'/Script/Engine.{class_name}')
    actor = editor.actors().spawn_actor_from_class(cls, place.vector(location), place.rotator(rotation))
    return scope.own(actor, label or f'GX_{class_name}', scope.ATMOSPHERE_SCOPE)


def _sun(p: Preset) -> None:
    actor = _spawn('DirectionalLight', (0.0, 0.0, 1000.0), (p.sun_pitch, p.sun_yaw, 0.0), 'GX_Sun')
    light = actor.get_component_by_class(unreal.DirectionalLightComponent)
    light.set_mobility(unreal.ComponentMobility.MOVABLE)
    light.set_intensity(p.sun_lux)
    light.set_use_temperature(True)
    light.set_temperature(p.sun_kelvin)
    light.set_light_source_angle(p.sun_angle)
    light.set_cast_volumetric_shadow(True)
    light.set_volumetric_scattering_intensity(p.sun_volumetric)
    light.set_enable_light_shaft_occlusion(True)
    light.set_enable_light_shaft_bloom(True)
    light.set_bloom_scale(0.2)
    light.set_bloom_threshold(4.0)
    light.set_atmosphere_sun_light(True)


def _sky(p: Preset) -> None:
    sky = _spawn('SkyLight', (0.0, 0.0, 1200.0), None, 'GX_SkyLight').get_component_by_class(unreal.SkyLightComponent)
    sky.set_mobility(unreal.ComponentMobility.MOVABLE)
    sky.set_real_time_capture(True)
    sky.set_intensity(p.sky_intensity)
    sky.set_light_color(_linear(p.sky_tint))
    sky.set_editor_property('lower_hemisphere_is_black', True)
    atmosphere = _spawn('SkyAtmosphere', (0.0, 0.0, 0.0), None, 'GX_SkyAtmosphere')
    component = atmosphere.get_component_by_class(unreal.SkyAtmosphereComponent)
    component.set_sky_luminance_factor(_linear((p.sky_luminance,) * 3))


def _fog(p: Preset) -> None:
    actor = _spawn('ExponentialHeightFog', (0.0, 0.0, p.fog_height), None, 'GX_HeightFog')
    fog = actor.get_component_by_class(unreal.ExponentialHeightFogComponent)
    fog.set_fog_density(p.fog_density)
    fog.set_fog_height_falloff(p.fog_falloff)
    fog.set_fog_inscattering_color(_linear(p.fog_color))
    fog.set_volumetric_fog(True)
    fog.set_volumetric_fog_scattering_distribution(p.fog_scatter)
    fog.set_volumetric_fog_albedo(unreal.Color(r=round(255 * p.fog_albedo), g=round(255 * p.fog_albedo),
                                               b=round(255 * p.fog_albedo), a=255))
    fog.set_volumetric_fog_extinction_scale(p.fog_extinction)
    fog.set_volumetric_fog_distance(p.fog_view_m * CM_PER_M)


def local_fog(location, radius_m=30.0, density=0.5, color=(0.42, 0.47, 0.53), label=None, scope_name=None):
    """A local fog volume (a sphere of haze, densest low down) of `radius_m` at `location`, in the open scope."""
    radius = float(radius_m)
    cls = unreal.load_class(None, '/Script/Engine.LocalFogVolume')
    actor = editor.actors().spawn_actor_from_class(cls, place.vector(location), place.rotator(None))
    actor.set_actor_scale3d(unreal.Vector(radius, radius, radius))
    component = actor.get_component_by_class(unreal.LocalFogVolumeComponent)
    component.set_radial_fog_extinction(float(density))
    component.set_height_fog_extinction(float(density))
    component.set_fog_albedo(_linear(color))
    return scope.own(actor, label, scope_name)


def _grade(p: Preset) -> None:
    volume = _spawn('PostProcessVolume', (0.0, 0.0, 0.0), None, 'GX_Grade')
    volume.set_editor_property('unbound', True)
    volume.set_editor_property('priority', 10.0)
    settings = volume.get_editor_property('settings')
    values = {
        'auto_exposure_method': unreal.AutoExposureMethod.AEM_MANUAL,
        'auto_exposure_apply_physical_camera_exposure': False,
        'auto_exposure_bias': p.exposure,
        'bloom_intensity': p.bloom,
        'vignette_intensity': p.vignette,
        'film_grain_intensity': p.grain,
        'color_saturation': unreal.Vector4(p.saturation, p.saturation, p.saturation, 1.0),
        'color_contrast': unreal.Vector4(p.contrast, p.contrast, p.contrast, 1.0),
        'color_gain_shadows': unreal.Vector4(p.shadow_tint[0], p.shadow_tint[1], p.shadow_tint[2], 1.0),
        'lens_flare_intensity': 0.0,
    }
    for name, value in values.items():
        settings.set_editor_property(f'override_{name}', True)
        settings.set_editor_property(name, value)
    volume.set_editor_property('settings', settings)


def atmosphere(preset, **overrides) -> dict:
    """Replaces the level's sky, light, air and grade with the preset's (see the module notes)."""
    p = resolve(preset, overrides)
    old = _replaced_actors()
    for actor in old:
        editor.actors().destroy_actor(actor)
    replaced = scope.replace_owned(scope.ATMOSPHERE_SCOPE)
    _sun(p)
    _sky(p)
    _fog(p)
    for x, y, z, radius in p.local_fogs:
        local_fog((x, y, z), radius, 0.5, p.fog_color, f'GX_LocalFog_{int(x)}_{int(y)}', scope.ATMOSPHERE_SCOPE)
    _grade(p)
    return {'preset': preset, 'removedTemplate': len(old), 'replaced': replaced,
            'made': len(scope.scope_actors(scope.ATMOSPHERE_SCOPE))}
