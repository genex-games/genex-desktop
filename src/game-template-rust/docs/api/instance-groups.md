# Retained instance groups

Many copies of one shape that rarely move (a forest, rocks, fence posts, a city's buildings)
draw as a retained group: made once, drawn every frame, its instance rows computed and uploaded
once instead of every frame (a 50,000-instance scatter drawn one by one writes 8 MB of rows a
frame; as a group, none after its first frame).

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
Things that move every tick stay ordinary draws.
