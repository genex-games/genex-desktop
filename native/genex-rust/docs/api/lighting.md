# Lighting, materials and environment

Light a frame with `frame.sun(direction, color, intensity)` (towards the sun; it casts the
shadows), `frame.ambient(color, intensity)`, `frame.point_light(position, range, color,
intensity)` and `frame.spot_light(position, direction, range, color, intensity)` (a cone, full
strength within 20 degrees of `direction` and dark past 30); a frame that names none keeps the
defaults (a white sun at 2.5 from `(0.4, 1, 0.3)`, white ambient at 0.08). For another cone or a
shadow map, `frame.spot_light_with(&SpotLight::new(position, direction, range, color, intensity)
.with_cone_degrees(25.0, 40.0).with_shadow(true))` (`use genex::render::SpotLight;`); the
device's quality decides how many spots get a shadow map (none on `low` and `medium`, two on
`high`, four on `ultra`, at most one on a phone), given to the asking spots on screen nearest the
camera, and the rest light unshadowed. A spot keeps its map until another stays clearly nearer
for a quarter of a second; the two shadows then cross-fade over a quarter of a second, so none pops
as the camera moves (a capture gives the maps to the nearest spots). Point and spot lights fade smoothly to nothing
at their range, so give each the range it needs, not more: a lantern 3 to 4 units, a street lamp
8. Every preset bins them by screen tile and depth, on the HDR and the LDR scene alike, so a scene
may hold hundreds; the preset caps how many a frame lights (phones at most 256), nearest first,
fading the farthest kept ones out so a light crossing the cap never pops. Give a draw its surface with a `Material`:
`Material::color(Color::rgb(255, 200, 80)).with_metallic(1.0).with_roughness(0.25)`, textures by
asset path with `.with_base_texture("textures/bark.png")`, `.with_normal_texture(path, strength)`
and, for roughness and metalness, `.with_metal_rough_texture(path)` (glTF's packing: green
roughness, blue metallic) or `.with_orm_texture(path)` for a packed occlusion-roughness-metallic
map (the `_ORM` or `_ARM` file of a CC0 set: red occlusion as well); a separate occlusion map is
`.with_occlusion_texture(path, strength)` (it darkens ambient light only, never the sun). The
maps multiply `roughness` and `metallic`, so set both to 1 to take a map's values as they are.
A texture covers each face of a mesh once by default; `.with_uv_scale(u, v)` repeats it `u` times
across and `v` times down, and `.with_world_uv(metres)` projects it from the world along the
axis each face looks at, repeating every `metres`: a 4 m wall drawn with `frame.cube_with`, a
0.2 m sill and a floor then show one texel size, never a stretched photo. World projection is for
geometry that stays put (a moving draw's texture slides) and for flat faces (a curved model shows
seams; give it `.with_uv_scale`). A tiled texture then repeats, and a long corridor shows the same
blotch every metre; break it up: `.with_uv_jitter(seed)` moves each panel's texture by an offset
drawn from its seed (use the panel's index in the level: the same seed gives the same offset
everywhere), `.with_uv_offset(u, v)` sets one, `.with_uv_rotation(radians)` turns the texture and
its normal map (plaster, concrete or dirt; never brick or wood grain),
`.with_stochastic_tiling(true)` blends every fetch from two copies at offsets that change across
the surface so no tile shows twice (a second fetch of the colour, normal and roughness maps; keep it
off a material with an emissive map), and `.with_macro_variation(strength, metres)` varies the
base colour by up to `strength` (0.1 to 0.25 reads as wear) in patches of about `metres`, from the
world position: what a single tile cannot hold. All are the same every frame and on every
destination:

```rust
let plaster = Material::color(Color::rgb(214, 206, 188))
    .with_base_texture("textures/plaster_albedo.jpg")
    .with_normal_texture("textures/plaster_normal.png", 1.0)
    .with_orm_texture("textures/plaster_orm.png")
    .with_roughness(1.0)
    .with_metallic(1.0)
    .with_world_uv(1.5)
    .with_stochastic_tiling(true)
    .with_macro_variation(0.18, 3.0);
for (index, panel) in level.panels.iter().enumerate() {
    frame.cube_with(panel.transform, &plaster.clone().with_uv_jitter(index as u32));
}
```

Drawn with `frame.cube_with`,
`frame.sphere_with` or `frame.model_with` (a GLB's own materials, emission and textures load by
themselves: an alpha-`MASK` leaf or fence is cut out in its shadow too, a `doubleSided` card
draws both faces, an occlusion map darkens its crevices' ambient light). A missing texture leaves the surface untextured; `.with_untextured_color(color)` names
the colour drawn then, so optional downloaded textures keep a stand-in. A texture keeps its resolution up to the size class the device and the game's
`[render]` choose at load (512 texels on `low`, 1024 on `medium`, 2048 from `high` on desktops;
phones stop at 1024), so author it at the size it is seen at; the classes stay fixed until the
game reloads (a person's preset change in the panel, or a capture "as a phone", keeps them), and
captures on one device always draw the same textures. Normal maps lose no sparkle with distance
or in a smaller class (their mips widen the roughness by what was averaged away). A
surface glows with `Material::emissive(color, strength)` or
`.with_emissive(color, strength)` (strength in a light's units: 1 is white lit to radiance 1,
above it the look's bloom haloes it; `.with_emissive_texture(path)` masks it). Emission lights
the picture, not other surfaces: pair a lantern's glowing glass with a `frame.point_light`, a lit
window with a `frame.spot_light` shining out of it. A surface that lets light through takes
`.with_subsurface(Subsurface::WAX)` (`use genex::Subsurface;`): `WAX` glows warm past its shadow
line, `SKIN` scatters red into it, `LEAF` shines when the sun is behind it (give it to broad leaves;
pine needles and other dense thin cards glow too brightly with it, so keep them opaque); tune one with
`Subsurface::new(color, thickness)` (linear colour 0..1, thickness 0..1, 1 lets nothing through),
`.with_transmission(share)`, `.with_power(p)` and `.with_depth(metres)` (how far light travels
inside it: a leaf's millimetres, a candle's centimetre). The sun's light through it is shadowed by
whatever stands between it and the sun. A model whose glTF material carries
`KHR_materials_diffuse_transmission` lets light through the same way with no call (its factor, in
the base colour).

A room's polished floor reflects the sky until it has a reflection probe:
`frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(eye).with_blend(0.4))`
(`use genex::render::ReflectionProbe;`) covers the axis-aligned box `min..max`, the room's inside
from its floor to its ceiling; glossy surfaces in it reflect a cube captured from `capture`
(default the box's centre; put it at eye height in the room), each wall seen where it stands,
fading into the sky and the next probe over `blend` units past the box's faces (overlapping probes
share their light, so no seam shows). The cube is
captured from the scene the first frame the probe appears, and again when the sky changes or the
probe's box or capture point moves: objects that move later are not in it. The device's quality
gives cubes to the first probes a frame declares (4 on `low`, 8 on `medium`, 16 on `high` and
`ultra`; 2 to 8 on phones); the rest reflect the sky. Give a probe to each room or courtyard,
not to open ground (the sky is its reflection already).

A room's surfaces take the sky's diffuse light through its walls, and a white floor stays white
beside a sunlit red wall, until it has an irradiance volume:
`frame.irradiance_volume(&IrradianceVolume::new(min, max).with_blend(0.3))`
(`use genex::render::IrradianceVolume;`) covers the axis-aligned box `min..max` with a grid of
cells (about one per metre; `.with_cells([x, y, z])`, 1 to 32 each, at most 4096) baked from the
scene: surfaces in it take their diffuse ambient light from the cells around them, the light the
room's own walls, floor and lamps bounce (the first bounce baked, the ones after it estimated, so a
ceiling the sun never reaches still takes some), fading into the sky's over `blend` units past the box's
faces. A cell behind a wall lends a surface no light, so a volume may reach across a wall into the
next room or the street. The grid is baked a few cells a frame the first time the volume appears
and fades in once baked, and again when the sky changes or the box or its cells change: objects
that move later do not change it. Only scenes the sky or an HDR map lights take it. The device's
quality bakes the first volumes a frame declares (4 on `medium`, 8 on `high` and `ultra`; 2 to 4
on phones at `high` and `ultra` only, none at a phone's own `medium` or `low` preset or on the
low phones); the rest take the sky's light. Give a volume to each
room or courtyard whose bounced colour matters, alongside its reflection probe.

Posters, puddles, grime and stains are decals, not thin boxes over a surface (which fight it for
depth and float off it at a distance): `frame.decal(&Decal::on_wall(center, facing, width,
height).with_base_texture("decals/poster.png"))` (`use genex::render::Decal;`) lays the texture
onto every surface in a box `width` by `height` centred on the wall, looking out along `facing`
and reaching 0.2 into and out of the wall (`.with_depth(d)`); `Decal::on_ground(center, width,
length)` lays one on the ground. The base texture's alpha is its shape (until it loads, the decal
is not drawn); `.with_color(c)` tints it, `.with_opacity(a)`, `.rotated(radians)` turns it on its
surface, `.with_normal_texture(path, strength)` and `.with_orm_texture(path)` add its bumps and
its occlusion-roughness-metallic, `.with_roughness(r)` and `.with_metallic(m)` give the surface
its sheen, `.with_albedo_mix(0.0)` keeps the surface's colour and `.with_flatten(1.0)` smooths its
bumps away: a puddle is `Decal::on_ground(..).with_base_texture("decals/puddle.png")
.with_color(dark).with_roughness(0.04).with_flatten(1.0)`. A decal fades on surfaces turned away
from it (no streaks down a wall from a floor decal) and towards the box's front and back.
Overlapping decals blend evenly whatever the order. The device draws the nearest 64 (16 on
phones), fading the farthest out. Decals reach Level-2 v2 materials too, through `gx_shade_pbr`
(textures of up to 256 texels there).

Give a frame an environment with `frame.environment(..)` (`use genex::render::Environment;`): it
lights the scene beyond its lights and is drawn behind it, the same on every device.
`Environment::sky()` is the physical sky, coloured by the frame's own sun, tuned with
`Environment::Sky(SkyParams::default().with_ground_albedo([0.1, 0.12, 0.06]))` (also
`with_sun_angular_radius_degrees`, `with_intensity`). Under the sky `frame.sun` is the light
outside the atmosphere: give it a white colour and let its elevation do the rest. The sky and the
surfaces both see it through the atmosphere, so a sun 5 to 12 degrees up gives a golden hour (sky
and ground warm alike), a lower one a sunset, and one below the horizon a dusk that no longer
lights the ground. Keep the sun's intensity at night and let it set: the stars come out as it goes
down (`.with_stars(2e-5)` is their default brightness, 0 for none), and a moon,
`.with_moon(Some(Moon::new(direction)))` (`use genex::render::Moon;`; `.with_moonlight(0.004)`, its
share of the sun's light, `.with_tint(..)`, `.with_earthshine(..)`, `.with_angular_radius_degrees(..)`),
is lit by that sun with its phase: put it opposite the sun for a full moon. Once the sun has set the
moon lights the ground and the sky, and reflections see the stars and the moonlit sky. Auto exposure
with an `.exposure_curve(..)` (Grading and the lens) keeps the night darker than the day. The air itself is data:
`.with_medium(SkyMedium::mars())` gives a dusty butterscotch sky, and `SkyMedium::earth()
.with_rayleigh(..).with_mie(..).with_absorption(..).with_planet(..)` any other. Clouds:
`.with_clouds(Some(Clouds::default().with_coverage(0.5)))` (`use genex::render::Clouds;`;
`.with_layer(base_km, thickness_km)`, `.with_density(..)`, `.with_offset([x_km, z_km])` to let them
drift, `.with_cirrus(0.6)` for high streaks) adds cumulus lit by the sun (by night, the moon),
drawn in the sky and seen by reflections and the ambient light, on desktop `medium` and up; `low`
and phones show a clear sky.
`Environment::hdri("env/sky.hdr")` lights the scene with an equirectangular
Radiance `.hdr` under `assets/` (`HdriEnvironment::new(path).with_rotation_degrees(90.0)
.with_intensity(0.5)`, inside `Environment::Hdri(..)`) and is drawn behind it. By default
(`HdriSun::Analytic`) the map's sun becomes the frame's sun: it is clamped out of the map's light
and replaces `frame.sun`'s direction and colour (turned and scaled with the map), so the shadows
fall where the map's light comes from; a map without a sun keeps `frame.sun`.
`.with_sun(HdriSun::Off)` keeps the map as it is and `frame.sun` as you set it. A map that is
missing or does not decode is logged once and the frame keeps the flat colour.
`Environment::Color`, what a frame that names none draws, is `frame.ambient` with `frame.clear`
behind. Where the device's quality turns image-based lighting on, the environment replaces
`frame.ambient` for built-in materials and `gx_shade_pbr` alike, and where it turns the sky on it
replaces the clear colour; elsewhere the flat ambient light and the clear colour stay, so keep
both sensible. An environment's light is brighter than a flat ambient: retune
`ev_compensation` (or the map's `with_intensity`) against a capture after adding one.

One exposure cannot hold a sunlit window and the dark room around it. On `high` and `ultra` local
exposure moves each region towards middle grey: bright ones (the yard through a window) by
`local_exposure_highlights` (default 0.6), dark ones (a corridor ceiling) by `local_exposure_shadows`
(0.8), keeping the detail inside each; 0.25 is strongest, 1 turns that side off. In code:
`RenderConfig::new().local_exposure(0.5, 0.8)`. Light the room
first (lamps, a volume); local exposure only redistributes what reaches the camera.

The air between is the look's fog, off by default: `[render.look]`'s `fog_*` keys, or in code
`RenderConfig::new().fog(Fog::default().with_density(0.02).with_height(0.3, 0.0).with_range(0.0, 0.9)
.with_color([1.0, 1.0, 1.0]))` (`use genex::render::Fog;`). Its in-scatter is the environment's
horizon light tinted by the colour; under the sky `.with_aerial_perspective(false)` drops the air's
own scattering. On desktop and web `high` and `ultra` the fog is a lit volume with sun shafts;
`.with_volumetric(false)` keeps the plain height fog there too. In the volume the sun's shadows
carve shafts (through a canopy, between buildings, in at a window) and point and spot lights glow
in it, so a street lamp in a misty night needs no glow sprite; elsewhere the same fog is drawn
without them. Inside a room's irradiance volume the fog takes the light the volume's cells see
there instead of the horizon's, so a corridor's air glows where its windows and lamps light it, not
with the sky through its walls. Fog gives depth: keep it thin outdoors, shape a valley's mist with the height
falloff rather than more density, and check in a capture that the near ground keeps its colour.
Never fake haze with stacked transparent planes.

Sun shadows are a row of the preset table, per device class, drawn as listed (the switch is `shadows`; `genex.toml`'s `[render.shadows]` sets `distance` and `blend_band` on every preset):

| preset | cascades x side | filter | depth, far cascades | reach | cascade blend, end fade |
| --- | --- | --- | --- | --- | --- |
| `low` | 2 x 1024 (phones: 2 x 768) | PCF 5x5 (phones: hardware 2x2) | 16-bit, every frame | 50 units | none, last 15 % |
| `medium` | 2 x 1536 | PCF 5x5 | 32-bit, every frame | 50 units | 10 %, last 10 % |
| `high` | 3 x 2048 | PCSS-lite (soft contact shadows) | 32-bit, every frame | 80 units | 10 %, last 10 % |
| `ultra` | 4 x 4096 | PCSS | 32-bit, every frame | 80 units | 10 %, last 10 % |

Neighbouring cascades blend across the band, so no seam shows where one ends, and the shadows fade
out before the shadow distance instead of stopping on a line. Shadows hold still while the camera
moves: the band lerps both cascades on every frame, PCSS finds the same blockers on every frame,
and the depth bias is one world-space distance per cascade, so a contact gap never changes size as
other objects come into view. At `high` and `ultra` under TAA an opaque surface's soft sun shadow
comes from a screen mask that averages PCSS over frames and filters it edge-aware, so a penumbra
holds still on a pan; transparent surfaces filter inline. A contact shadow's edge (PCSS's
narrowest kernel, three texels) runs straight across the shadow map's texels instead of following
their staircase. Phones are held to 2 cascades of at most 1536 px, 5x5 PCF in place of PCSS,
16-bit depth and 40 units (on the high and ultra phone classes each preset's own reach up to 80
units: `medium` 50, `high` and `ultra` 80, and a game may ask for up to 80), and the far cascade
redraws every second frame
(and on every frame something in it moves, so a walking character's shadow never steps at half
rate); the weakest phone class draws 512 px cascades. A Live frame does not redraw a shadow map
whose objects all stood still for a few frames (a mesh counts as still when every instance does);
on desktop up to `high`'s maps it also keeps a copy of the still objects and redraws only what
moves over it. So a large still world costs little shadow time: a spot light's map stays cached
however the camera moves, the sun's while the camera stands still. A mesh with some instances
moving is drawn every frame, so give a moving prop its own mesh to keep the rest cached. The low desktop tier also draws 16-bit depth with the far cascade every second frame. A request never passes a class's caps, so one config is right
on every device. To ask for more at one preset, from code:
`RenderConfig::new().shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4))`
(`genex::render::ShadowConfig`: `.cascades(1..=4)`, `.map_size(512..=4096)`,
`.filter(ShadowFilter::Pcf5x5)`, `.distance(10..=400)` world units, `.blend_band(0.0..=0.5)` of
each cascade; the other presets keep their rows, and a later call for the same preset wins key by
key). Per class, `RenderConfig::class(class, ClassOverride { shadows, ..Default::default() })`.


Size the reach to the world: a small arena wants `distance = 30` (sharper shadows near the camera,
since the cascades cover less ground), an open landscape the preset's or more. A cascade covers more
ground the farther it is, so a distant shadow is softer and less exact by design. The light size is
the sky's sun: by default the real sun (0.27 degrees), so a PCSS penumbra is narrow, contact
shadows soften a little and a long cast shadow a lot more. A softer, overcast look is
`frame.environment(Environment::Sky(SkyParams::default().with_sun_angular_radius_degrees(2.0)))`
(0 to 5 degrees; the drawn sun disk grows with it), and only the PCSS filters (`high`, `ultra`)
widen their penumbra with it, up to 1 world unit on every preset; the flat colour and an HDR map
keep the real sun's size.
