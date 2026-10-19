# Big meshes (meshlets)

Big meshes can draw as meshlets (R2): a mesh of at least 2048 triangles is split once into
clusters of at most 124 triangles, the GPU culls each cluster on its own (outside the view, facing
away), and with occlusion a second pass against a depth pyramid of what was just drawn (two-pass
Hi-Z occlusion) drops the clusters hidden behind others. No preset turns them on, on any device,
because they measured slower: on an M4 Max at 1080p `high`, meshlets cost 26% to 51% more GPU time
than the instance path and occlusion 49% to 55% more, even in a walled scene where occlusion draws
a thirtieth of the vertices; on the phone proxy about twice the time. A tile GPU (phones, Apple
Silicon Macs) already rejects hidden pixels on chip, and no PC GPU has shown a gain yet. A game
opts in per class, only where its own measurement shows a gain (a huge world that hides most of
its geometry):

```toml
[render.class.desktop-high]
meshlets = true
occlusion = true    # runs only over a one-sample world pass: off under MSAA, so on with TAA
```

In code: `RenderConfig::new().class(class, ClassOverride { switches: vec![(RenderFeature::Meshlets,
true)], ..Default::default() })`. Occlusion builds its depth pyramid from one sample per pixel, so
under MSAA (`low` and `medium`) the switch resolves off and `volatile.render.features`
says so; the picture never changes, only the cost. The game's `Meshlets` setting then narrows what
runs: `.with_enabled(false)` opts out, `.with_occlusion(false)` drops occlusion,
`.with_min_triangles(4096)` clusters fewer meshes (at least 124); `genex::render::Meshlets`.
Nothing is clustered until a quality draws meshlets. A model imported through the Studio's asset
import already carries its clusters (meshoptimizer's, stored in the GLB); the renderer checks them
when it clusters, and a set that fails the check is logged with its typed fault
(`meshlets-unknown-version`, ...) and the mesh is clustered at runtime, so a hand-made GLB needs
nothing extra. The person's settings panel has the last word. If you opt in, model the world as a
few big meshes (terrain, walls, a building, a statue) rather than thousands of small ones, and
leave small props as instances. Every candidate is re-tested against the new depth each frame,
so a moving camera never shows a stale hole; a camera cut and a capture start with no visibility
history. A meshlet picture is not guaranteed bit-equal to the instance path's: where two draws tie in
depth they may resolve in another order.
