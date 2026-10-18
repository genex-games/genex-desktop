// A particle's billboard, shared by its draw (`particles_draw.wgsl`) and TAA's reactive coverage
// of it (`post::taa::REACTIVE_PARTICLES`), so the mask covers what is drawn: the emitter's row and
// its particles' shapes (row for row with `particles_drawn`), and where each corner of the quad
// sits in the world. The including shader declares `frame` (group 0) and `particles_drawn`.

@group(1) @binding(1) var<uniform> particle_emitter: Emitter;
@group(1) @binding(2) var<storage, read> particle_shapes_drawn: array<ParticleShape>;

// The quad's corner for `vertex` (two triangles, six vertices).
fn particle_quad_corner(vertex: u32) -> vec2<f32> {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
    );
    return corners[vertex];
}

// Where one corner of a billboard sits in the world. The camera's own right and up are the first
// two rows of the (unjittered, symmetric) view-projection: a billboard faces the camera at every
// pitch. A basis crossed with the world's +Y was zero, and so NaN, under a camera looking straight
// up or down (renderer pass 2, LG-08/S9). A stretched emitter's billboard instead lies along its
// particle's motion across the view, trailing `stretch` ticks of it (rain); otherwise the corner
// turns by the particle's rotation.
fn particle_corner_world(p: Particle, shape: ParticleShape, corner: vec2<f32>) -> vec3<f32> {
    let vp = frame.view_proj;
    let right = normalize(vec3<f32>(vp[0].x, vp[1].x, vp[2].x));
    let up = normalize(vec3<f32>(vp[0].y, vp[1].y, vp[2].y));
    let half = p.position_size.w * 0.5;
    let stretch = particle_emitter.shape.w;
    let forward = frame.camera_forward.xyz;
    let across = shape.motion.xyz - forward * dot(shape.motion.xyz, forward);
    let trail = length(across) * stretch;
    if stretch > 0.0 && trail > 1e-6 {
        let along = across / length(across);
        let side = normalize(cross(along, forward));
        return p.position_size.xyz + side * (corner.x * half) + along * (corner.y * (half + 0.5 * trail) - 0.5 * trail);
    }
    var turned = corner;
    let angle = shape.motion.w;
    if angle != 0.0 {
        let c = cos(angle);
        let s = sin(angle);
        turned = vec2<f32>(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    }
    return p.position_size.xyz + (right * turned.x + up * turned.y) * half;
}
