# Retained instance groups

Many copies of one shape that rarely move (a forest, rocks, fence posts, a city's buildings)
draw as a retained group: made once, drawn every frame, its instance rows computed and uploaded
once instead of every frame (a 50,000-instance scatter drawn one by one writes 8 MB of rows a
frame; as a group, none after its first frame).

The group types are at the crate root, not in the prelude. Every type and call in one line:

```rust
use genex::{Far, InstanceGroup, InstanceGroupError};           // and INSTANCE_GROUP_MAX
InstanceGroup::cubes(transforms, &material); InstanceGroup::spheres(transforms, &material); // -> Result<InstanceGroup, InstanceGroupError>
InstanceGroup::models(&model, transforms); InstanceGroup::models_with(&model, transforms, &material); // transforms: Vec<Transform>
frame.group(&group);
group.update(first, &transforms);                              // -> Result<(), InstanceGroupError>
group.with_far(Far::thin(start, end).fading_out(metres));      // -> Result<InstanceGroup, InstanceGroupError>
```

```rust
// on_reset: keep the group in the world.
let trees = (0..5000).map(|i| Transform::from_xyz((i % 100) as f32, 0.0, (i / 100) as f32)).collect();
sim.world.forest = Some(InstanceGroup::models(&pine, trees).expect("a group"));
// on_draw:
if let Some(forest) = &sim.world.forest { frame.group(forest); }
```

`InstanceGroup::cubes(transforms, &material)`, `InstanceGroup::spheres(transforms, &material)`
(radius 1: scale the transform), `InstanceGroup::models(&model, transforms)` (the GLB's materials)
and `InstanceGroup::models_with(&model, transforms, &material)` make one; `frame.group(&group)`
draws it, one logical draw, and the picture is the one drawing each transform with `frame.cube`,
`frame.sphere` or `frame.model` gives. `group.update(first, &transforms)` (in `on_update`)
replaces a range and only those rows are uploaded again. A group holds at most
`INSTANCE_GROUP_MAX` transforms (`too-many-instances`); an update past its end is refused
(`range-out-of-group`) and changes nothing. A missing model draws the checker at every transform.
`group.with_far(Far::thin(start, end))` answers the group thinned far from the camera: past
`start` metres fewer, larger copies, a quarter of them at `end`, then none over a tenth of `end`
(`.fading_out(metres)` sets that fade; 0 keeps them to the horizon). The renderer keeps a copy by
a hash of where it stands, so a moving camera never pops one and a scatter thins evenly; the sim
still sees every transform. The class's `far_density` (see Drawing) keeps a share of that on every
group. Numbers out of range (`0 <= start < end`, all finite, a fade of at least 0) are refused
`far-invalid` and the group is unchanged. A frame holds 16 far fields; a group past them draws
whole.
Things that move every tick stay ordinary draws.
