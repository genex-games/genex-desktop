// The frame bind group's environment (RQ2.0, `layout::FRAME_ENV_BINDINGS`): the names and types
// the Level-2 v2 material map gives the same inputs, so the lighting chunks read them alike in
// the forward pass and in `gx_shade_pbr`. Until the environment bake lands they hold the neutral
// inputs: a black cube, zero SH and the split-sum identity.

@group(0) @binding(11) var env_specular: texture_cube<f32>;
@group(0) @binding(12) var<uniform> env_sh: GxEnvSh;
@group(0) @binding(13) var brdf_lut: texture_2d<f32>;
@group(0) @binding(14) var env_sampler: sampler;
