# Look recipes

One block per scene type: the sky and sun in numbers, the `[render.look]` exposure and fog, the
probe and volume rule, the material and dressing bar, the particles and the luma band a settled
`ultra` capture of the main camera sits inside. The code in each block is compiled and captured
by the engine's own tests: it is `docs/examples/looks/src/looks.rs`, whose `light` function you
call first in `on_draw` and whose `look` function you pass `RenderConfig::from_build()` to in
`wire`. Copy your scene's pair, then tune against a capture of your own level, one number at a
time. The units, the exposure defaults and the luma, texel and frame-rate tables behind these
numbers are `docs/calibration.md`; the per-class budgets are `docs/api/performance.md`.

Every block assumes the shared rules below. A scene that mixes two types (a lit room seen from a
night street) takes the recipe of the camera the person plays from, and the other side's lights.

## Shared rules

- **Sun.** `frame.sun(towards, Color::WHITE, intensity)`: the vector points at the sun (it need
  not be unit length); its elevation is the time of day. Keep the colour white under
  `Environment::sky()`: the atmosphere colours it. Intensity 2.5 (the default) to 3.0; never raise
  it to brighten a room.
- **Exposure.** `exposure = "auto"` everywhere light meets shade. `ev_min = -8` and `ev_max = 8`
  (the defaults) stay: raising `ev_min` to keep a room bright fights the doorway adaptation and
  blows the next sunlit window out. Night keeps its dark through `.exposure_curve(..)`, never
  through a low `ev_max` or a dark grade.
- **One darkening control at a time.** Negative compensation, a raised `ev_min`, a vignette and a
  dark grade together crush a room to black (`stacked-darkening`).
- **Probes and volumes.** Each room, hall or courtyard: one `ReflectionProbe` and one
  `IrradianceVolume` on the same box, every frame, blend about the wall's thickness. Open ground
  needs neither.
- **Materials.** Every surface the camera comes within 10 m of is a scan at `2k` (`4k` for a
  hero surface filling a desktop screen) with its normal and ORM maps, at its real size
  (`.with_world_uv(metres)`), `.with_stochastic_tiling(true)` and a macro variation. A
  flat-coloured material is for something under 10 cm or farther than 50 m.
- **Dressing.** Hero props within 3 m of the camera's path, mid dressing every 2 to 4 m, ground
  cover and clutter in between; no area of floor or ground larger than 4 m by 4 m bare in view.
- **Luma.** Mean Rec. 709 luma (0 to 255) of a settled 1280x720 `ultra` capture of the main
  camera, lens off. Inside the band is the recipe working; outside it, change the light first,
  then the compensation, never the grade.

## Interior day

| Part | Value |
| --- | --- |
| Sun | `(0.35, 0.32, 1.0)`, about 17 degrees up, through the windows; intensity 3.0 |
| Sky | `Environment::sky()`; ambient `rgb(170, 185, 210)` at 0.15 where no sky draws |
| `[render.look]` | `exposure = "auto"`, `metering = "average"`, `ev_compensation = 0`, `ev_min = -8`, `ev_max = 8` |
| Fog | `fog_density = 0.012`, `fog_height_falloff = 0.05`: shafts in the window light on `high` and `ultra` |
| Local exposure | highlights 0.6, shadows 0.8 (the defaults): the yard through a window keeps detail |
| Probes, volumes | one of each per room on the room's box |
| Lights | the sun; fittings glow with `Material::emissive` and stay unlit by day |
| Dressing | desks, chairs, radiators under windows, wear decals along the dado and under sills |
| Particles | `Particles::dust(..)` in a shaft, optional |
| Luma | 90 to 130 |

<!-- compiled: looks/interior-day -->
```rust
/// A room by day: a low sun falls in at the windows, the sky lights the rest through them.
pub fn interior_day(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.15);
    frame.sun(vec3(0.35, 0.32, 1.0), Color::WHITE, 3.0); // 17 degrees up: shafts reach the floor
    frame.environment(Environment::sky());
}

/// Auto exposure meters the room (the windows burn out, as a camera sees them), thin room fog.
pub fn interior_day_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(0.0).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.012).with_height(0.05, 0.0))
        .local_exposure(0.6, 0.8)
        .grading(Grading::NEUTRAL.with_contrast(1.05).with_saturation(0.95))
}
```

## Interior night

| Part | Value |
| --- | --- |
| Sun | `(0.3, -0.25, 1.0)`: set below the horizon, intensity kept at 2.5 so stars and the moon's phase stay right |
| Sky | `SkyParams::default().with_moon(Some(Moon::new([-0.4, 0.5, 0.8])))`; ambient 0.02 |
| `[render.look]` | `exposure = "auto"`, `metering = "center"`, `ev_compensation = -0.3`, `ev_min = -8`, `ev_max = 8` |
| Exposure curve | `.exposure_curve(&[(-8.0, -2.0), (-3.0, -0.8), (0.0, 0.0)])`: a dark meter stays dark |
| Fog | `fog_density = 0.008`, `fog_height_falloff = 0.05` |
| Probes, volumes | one of each per room; the volume bakes the lamps' bounce |
| Lights | every glowing fitting (`Material::emissive(color, 6.0)`) paired with a `frame.point_light(.., 6.0, color, 2.2)` or a shadowed spot; pools of light, dark corners |
| Dressing | as by day; a lit room reads by what its lamps fall on |
| Particles | none, or dust in a lamp's cone |
| Luma | 45 to 85 (a horror brief may go to 30, with every light source still readable) |

<!-- compiled: looks/interior-night -->
```rust
/// A room by night: the sun has set, the moon is up outside, the room's own lamps carry it.
pub fn interior_night(frame: &mut Frame) {
    frame.clear(Color::rgb(8, 10, 16)).ambient(Color::rgb(60, 70, 100), 0.02);
    frame.sun(vec3(0.3, -0.25, 1.0), Color::WHITE, 2.5); // below the horizon: stars come out
    let moon = Moon::new([-0.4, 0.5, 0.8]);
    frame.environment(Environment::Sky(SkyParams::default().with_moon(Some(moon))));
}

/// Auto exposure with a curve that keeps a dark meter dark, so night never reads as day.
pub fn interior_night_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Center).compensation(-0.3).range(-8.0, 8.0))
        .exposure_curve(&[(-8.0, -2.0), (-3.0, -0.8), (0.0, 0.0)])
        .fog(Fog::default().with_density(0.008).with_height(0.05, 0.0))
        .grading(Grading::NEUTRAL.with_contrast(1.08))
        .temperature(0.1, 0.0)
}
```

## Exterior day

| Part | Value |
| --- | --- |
| Sun | `(0.4, 1.0, 0.3)`, about 55 degrees up; intensity 2.5 |
| Sky | `Environment::Sky(SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(0.35))))` |
| `[render.look]` | `exposure = "auto"`, `metering = "ground"` (an open sky does not darken the ground), `ev_compensation = 0.5` |
| Fog | `fog_density = 0.002`, `fog_height_falloff = 0.08`, `fog_aerial_perspective = true`: distance turns blue |
| Probes, volumes | none on open ground; one of each per courtyard |
| Ground | one `Terrain` with scan layers, blended by a control map; never a box |
| Dressing | ground cover and scatter (`terrain.scatter(..)`), props in clusters, trees as models with impostors past their last level |
| Particles | none; dust where wind is in the brief |
| Luma | 95 to 140 |

<!-- compiled: looks/exterior-day -->
```rust
/// Open ground at mid-morning: a high white sun, scattered cumulus, the physical sky.
pub fn exterior_day(frame: &mut Frame) {
    frame.clear(Color::rgb(130, 170, 220)).ambient(Color::rgb(180, 200, 230), 0.1);
    frame.sun(vec3(0.4, 1.0, 0.3), Color::WHITE, 2.5); // about 55 degrees up
    let clouds = Clouds::default().with_coverage(0.35);
    frame.environment(Environment::Sky(SkyParams::default().with_clouds(Some(clouds))));
}

/// Half a stop over the meter for sunlight, a little aerial haze, a touch of vibrance.
pub fn exterior_day_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Ground).compensation(0.5).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.002).with_height(0.08, 0.0))
        .grading(Grading::NEUTRAL.with_vibrance(1.1))
}
```

## Overcast and snow

| Part | Value |
| --- | --- |
| Sun | `(0.3, 0.6, 0.5)`, intensity 2.5, veiled by the overcast sky: soft shadows, never black ones |
| Sky | `SkyParams::overcast().with_ground_albedo([0.8, 0.82, 0.85])`: a bright grey sky over white ground |
| `[render.look]` | `exposure = "auto"`, `metering = "average"`, `ev_compensation = 1.0`: the meter turns snow grey, one stop over makes it white |
| Fog | `fog_density = 0.012`, `fog_height_falloff = 0.06`, `fog_color = [0.85, 0.88, 0.92]` |
| Grade | `.temperature(-0.15, 0.0)` |
| Ground | a `Terrain` whose layer is a snow scan (normal and ORM); snow on props is their material, never a slab |
| Particles | `Particles::snow(top, half_extent)` over the playable area, falling past the camera |
| Luma | 125 to 175 |

<!-- compiled: looks/overcast-snow -->
```rust
/// Snow under a bright grey sky: a veiled sun, white ground (a terrain layer), falling flakes.
pub fn overcast_snow(frame: &mut Frame) {
    frame.clear(Color::rgb(200, 205, 212)).ambient(Color::rgb(210, 215, 225), 0.2);
    frame.sun(vec3(0.3, 0.6, 0.5), Color::WHITE, 2.5);
    let sky = SkyParams::overcast().with_ground_albedo([0.8, 0.82, 0.85]);
    frame.environment(Environment::Sky(sky));
}

/// Snow meters grey: open one stop over the meter so it reads white; cold, soft air.
pub fn overcast_snow_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(1.0).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.012).with_height(0.06, 0.0).with_color([0.85, 0.88, 0.92]))
        .temperature(-0.15, 0.0)
}
```

## Rain

| Part | Value |
| --- | --- |
| Sun | `(-0.2, 0.7, 0.4)`, intensity 2.5 under a dimmed overcast sky |
| Sky | `SkyParams::overcast().with_intensity(0.6)` |
| `[render.look]` | `exposure = "auto"`, `metering = "average"`, `ev_compensation = 0` |
| Fog | `fog_density = 0.02`, `fog_height_falloff = 0.1`, `fog_color = [0.6, 0.64, 0.7]` |
| Grade | contrast 1.05, saturation 0.85, `.temperature(-0.2, 0.0)` |
| Materials | wet: roughness about a third of dry on ground, roads and metal; puddles are `Decal::on_ground(..).with_roughness(0.04).with_flatten(1.0)` |
| Probes, volumes | a reflection probe over a street makes its wet ground reflect it |
| Particles | `Particles::rain(top, half_extent)` over the playable area |
| Luma | 70 to 110 |

<!-- compiled: looks/rain -->
```rust
/// Rain: a dimmer overcast sky, no hard shadows, wet surfaces (low roughness) and drops.
pub fn rain(frame: &mut Frame) {
    frame.clear(Color::rgb(90, 96, 104)).ambient(Color::rgb(140, 150, 165), 0.12);
    frame.sun(vec3(-0.2, 0.7, 0.4), Color::WHITE, 2.5);
    frame.environment(Environment::Sky(SkyParams::overcast().with_intensity(0.6)));
}

/// The meter as it is, thicker low fog, a cooler and less saturated grade.
pub fn rain_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(0.0).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.02).with_height(0.1, 0.0).with_color([0.6, 0.64, 0.7]))
        .grading(Grading::NEUTRAL.with_contrast(1.05).with_saturation(0.85))
        .temperature(-0.2, 0.0)
}
```

## Night street

| Part | Value |
| --- | --- |
| Sun | `(-0.3, -0.4, 1.0)`: well below the horizon, intensity 2.5 |
| Sky | `SkyParams::default().with_moon(Some(Moon::new([0.5, 0.6, -0.6]))).with_stars(2e-5)`; ambient 0.01 |
| `[render.look]` | `exposure = "auto"`, `metering = "average"`, `ev_compensation = -0.5` |
| Exposure curve | `.exposure_curve(&[(-8.0, -2.5), (-3.0, -1.0), (0.0, 0.0)])` |
| Fog | `fog_density = 0.015`, `fog_height_falloff = 0.08`: mist catches the lamps |
| Bloom | `bloom_intensity = 0.06` |
| Lights | a street lamp every 8 m: `Material::emissive(rgb(255, 196, 130), 8.0)` head, `frame.spot_light(head, down, 12.0, color, 4.0)`; lit windows emissive with a point light behind |
| Materials | wet or not, as the rain block; signs and windows emissive |
| Particles | rain or none |
| Luma | 25 to 65, with every lamp's pool readable |

<!-- compiled: looks/night-street -->
```rust
/// A street at night: the sun well down, a moon, the street's lamps the main light.
pub fn night_street(frame: &mut Frame) {
    frame.clear(Color::rgb(4, 6, 12)).ambient(Color::rgb(40, 50, 80), 0.01);
    frame.sun(vec3(-0.3, -0.4, 1.0), Color::WHITE, 2.5);
    let moon = Moon::new([0.5, 0.6, -0.6]);
    frame.environment(Environment::Sky(SkyParams::default().with_moon(Some(moon)).with_stars(2e-5)));
}

/// A dark meter stays dark (the curve), lamps bloom a little, mist catches their light.
pub fn night_street_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(-0.5).range(-8.0, 8.0))
        .exposure_curve(&[(-8.0, -2.5), (-3.0, -1.0), (0.0, 0.0)])
        .fog(Fog::default().with_density(0.015).with_height(0.08, 0.0))
        .bloom(Bloom::new(0.06))
}
```

## Forest

| Part | Value |
| --- | --- |
| Sun | `(0.5, 0.8, -0.2)`, about 40 degrees up; intensity 2.5, through broken cloud |
| Sky | `SkyParams::default().with_ground_albedo([0.1, 0.14, 0.06]).with_clouds(Some(Clouds::default().with_coverage(0.5)))` |
| `[render.look]` | `exposure = "auto"`, `metering = "average"`, `ev_compensation = 0.3` |
| Fog | `fog_density = 0.015`, `fog_height_falloff = 0.1`: volumetric shafts between trunks on `high` and `ultra` |
| Materials | bark and leaves from models; leaves `.with_subsurface(Subsurface::LEAF)`, alpha cards two-sided |
| Ground | a `Terrain` with grass (`Grass::meadow(..)`), litter and rock layers |
| Dressing | trunks every 3 to 6 m, undergrowth between, fallen wood; never one tree model in rows |
| Particles | dust or pollen in the shafts |
| Luma | 95 to 140 |

<!-- compiled: looks/forest -->
```rust
/// A forest clearing: a sun through broken cloud, green ground bounce, deep air.
pub fn forest(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 150, 170)).ambient(Color::rgb(150, 175, 150), 0.1);
    frame.sun(vec3(0.5, 0.8, -0.2), Color::WHITE, 2.5); // about 40 degrees up
    let sky = SkyParams::default().with_ground_albedo([0.1, 0.14, 0.06]);
    frame.environment(Environment::Sky(sky.with_clouds(Some(Clouds::default().with_coverage(0.5)))));
}

/// The meter as it is (shade and sun patches sit together), volumetric air for shafts.
pub fn forest_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(0.3).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.015).with_height(0.1, 0.0))
        .grading(Grading::NEUTRAL.with_vibrance(1.05))
}
```

## Desert and sunny

| Part | Value |
| --- | --- |
| Sun | `(0.2, 1.0, 0.1)`, about 75 degrees up; intensity 2.8: short, hard shadows |
| Sky | `SkyParams::default().with_medium(SkyMedium::earth()).with_ground_albedo([0.45, 0.35, 0.22])` |
| `[render.look]` | `exposure = "auto"`, `metering = "ground"`, `ev_compensation = 0.3` |
| Fog | `fog_density = 0.004`, `fog_height_falloff = 0.05`, `fog_color = [1.0, 0.92, 0.8]`: a dusty horizon |
| Grade | `.temperature(0.2, 0.0)` |
| Ground | a `Terrain` with sand and rock scan layers; dunes from the heights |
| Particles | `Particles::dust(..)` blown along the ground where the brief has wind |
| Luma | 115 to 160 |

<!-- compiled: looks/desert -->
```rust
/// Desert noon: a high hard sun, warm sand bounce, a dusty horizon.
pub fn desert(frame: &mut Frame) {
    frame.clear(Color::rgb(170, 190, 215)).ambient(Color::rgb(220, 200, 170), 0.1);
    frame.sun(vec3(0.2, 1.0, 0.1), Color::WHITE, 2.8); // about 75 degrees up
    let sky = SkyParams::default().with_medium(SkyMedium::earth()).with_ground_albedo([0.45, 0.35, 0.22]);
    frame.environment(Environment::Sky(sky));
}

/// A third of a stop over the meter for bright sand, warm haze far off, a warm grade.
pub fn desert_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Ground).compensation(0.3).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.004).with_height(0.05, 0.0).with_color([1.0, 0.92, 0.8]))
        .temperature(0.2, 0.0)
}
```

## Not yet in these recipes

Trees, ground cover scatter, snow cover on materials and a first-person camera rig are being
added to the engine; until they land, build foliage from CC0 models with impostors and keep
snow as a terrain layer and the props' own maps.
