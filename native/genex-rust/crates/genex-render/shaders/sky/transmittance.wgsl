// The physical sky, LUT 1 (RQ2.2): Hillaire's transmittance LUT, the transmittance from a height
// to the top of the atmosphere along a zenith angle (Bruneton's mapping: u the distance to the top
// between its least and greatest, v the height through the horizon distance), `rgba16float`
// write-only storage, 256 x 64. A function of the atmosphere alone: refreshed when it changes.
//
// WGSL has no includes and each sky pass is common.wgsl plus one file, so the medium below is
// repeated in multiscatter.wgsl and sky_view.wgsl; tests/sky.rs holds the three to one behaviour.

@group(0) @binding(0) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(1) var transmittance_out: texture_storage_2d<rgba16float, write>;

// Midpoint samples along each path to the top.
const SKY_TRANSMITTANCE_STEPS: u32 = 40u;

// Extinction (per km) at `height` km above the ground: Rayleigh and Mie falling off exponentially,
// ozone in a tent about its layer's centre.
fn sky_extinction(height: f32) -> vec3<f32> {
    let rayleigh = atmosphere.rayleigh.rgb * exp(-height * atmosphere.rayleigh.w);
    let mie = atmosphere.mie.y * exp(-height * atmosphere.mie.w);
    let ozone = atmosphere.ozone.rgb * max(0.0, 1.0 - abs(height - atmosphere.radii.z) / (0.5 * atmosphere.radii.w));
    return rayleigh + vec3<f32>(mie) + ozone;
}

@compute @workgroup_size(8, 8, 1)
fn cs_transmittance(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= atmosphere.luts.x || id.y >= atmosphere.luts.y {
        return;
    }
    let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(atmosphere.luts.xy);
    let bottom = atmosphere.radii.x;
    let top = atmosphere.radii.y;
    let horizon = sqrt((top - bottom) * (top + bottom));
    let rho = horizon * uv.y;
    // r - bottom without the cancellation of sqrt(rho^2 + bottom^2) - bottom near the ground.
    let start = rho * rho / (sqrt(rho * rho + bottom * bottom) + bottom);
    let r = bottom + start;
    let d_min = top - r;
    let d_max = rho + horizon;
    let distance_to_top = d_min + uv.x * (d_max - d_min);
    var mu = 1.0;
    if distance_to_top > 0.0 {
        mu = clamp((horizon * horizon - rho * rho - distance_to_top * distance_to_top) / (2.0 * r * distance_to_top), -1.0, 1.0);
    }
    let dt = distance_to_top / f32(SKY_TRANSMITTANCE_STEPS);
    var depth = vec3<f32>(0.0);
    for (var i = 0u; i < SKY_TRANSMITTANCE_STEPS; i++) {
        let t = (f32(i) + 0.5) * dt;
        let radius = sqrt(r * r + t * t + 2.0 * r * mu * t);
        depth += sky_extinction(max(radius - bottom, 0.0)) * dt;
    }
    textureStore(transmittance_out, vec2<i32>(id.xy), vec4<f32>(exp(-depth), 1.0));
}
