// The cloud panorama's mapping (renderer pass 2 B.5, `clouds.rs`): shared by the march
// (sky/clouds.wgsl) and the sky's two composites (sky/sky_draw.wgsl's background and
// sky/sky_view.wgsl's `cs_sky_cube`). u runs once around the horizon from -X (atan2 of z over x,
// +Z a quarter on); v runs from the zenith (0) to the horizon (1), the elevation over a right angle
// going as (t + t^2) / 2 of t = 1 - v: texels are three times as dense at the horizon (distant
// clouds are thin and small there) as at the zenith.
// Nothing below the horizon: the camera stands under the layer.

const GX_CLOUD_PI: f32 = 3.14159265358979;

// The panorama's uv along unit `dir` (dir.y >= 0).
fn gx_cloud_uv(dir: vec3<f32>) -> vec2<f32> {
    let u = atan2(dir.z, dir.x) / (2.0 * GX_CLOUD_PI) + 0.5;
    let share = asin(clamp(dir.y, 0.0, 1.0)) / (0.5 * GX_CLOUD_PI);
    let v = 1.0 - (sqrt(0.25 + 2.0 * share) - 0.5);
    return vec2<f32>(u, v);
}

// The unit direction at panorama `uv` (gx_cloud_uv's inverse).
fn gx_cloud_dir(uv: vec2<f32>) -> vec3<f32> {
    let azimuth = (uv.x - 0.5) * 2.0 * GX_CLOUD_PI;
    let up = 1.0 - uv.y;
    let elevation = 0.25 * GX_CLOUD_PI * (up + up * up);
    let flat = cos(elevation);
    return vec3<f32>(flat * cos(azimuth), sin(elevation), flat * sin(azimuth));
}

// `sky`, the radiance along unit `dir` (the sun's and moon's disks included), seen through panorama
// texel `clouds` (rgb the clouds' light as it reaches the camera with the sky's in front of them, a
// the clouds' transmittance).
fn gx_clouds_over(sky: vec3<f32>, clouds: vec4<f32>) -> vec3<f32> {
    return sky * clouds.a + clouds.rgb;
}
