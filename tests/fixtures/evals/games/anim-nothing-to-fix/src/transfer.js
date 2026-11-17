// Carries a clip made for one skeleton over to a hero with another skeleton: other bone names,
// another resting pose, other bone lengths.
import * as THREE from "three";

const SAMPLE_RATE = 30;

/**
 * A clip that makes `hero` move as `clip` moves `source`. Both must be in their rest pose when
 * this is called. `sourceName` gives the source's bone for a hero bone (or nothing when it has
 * none) and `heroHips` names the hero's hip bone. Every bone's turn is taken in world space,
 * measured from the source's rest pose and applied from the hero's rest pose, after the hero's
 * resting bones are lined up with the source's. The hips also carry the body's travel, scaled to
 * the hero's height.
 */
export function transferClip(clip, source, hero, heroHips, sourceName) {
  source.updateMatrixWorld(true);
  hero.updateMatrixWorld(true);
  const worldTurn = (object) => object.getWorldQuaternion(new THREE.Quaternion());
  const worldPoint = (object) => object.getWorldPosition(new THREE.Vector3());

  const matched = new Map();
  hero.traverse((bone) => {
    const name = bone.isBone ? sourceName(bone.name) : null;
    const from = name ? source.getObjectByName(name) : null;
    if (from) matched.set(bone, { from, fromRest: worldTurn(from), rest: worldTurn(bone), align: new THREE.Quaternion(), values: [] });
  });
  for (const [bone, entry] of matched) {
    const children = bone.children.filter((child) => matched.has(child));
    if (children.length !== 1) {
      // A hand, a toe or a head has no matched child to point at: it turns with the bone it hangs on.
      const parent = matched.get(bone.parent);
      if (parent && children.length === 0) entry.align.copy(parent.align);
      continue;
    }
    const along = worldPoint(children[0]).sub(worldPoint(bone)).normalize();
    const fromAlong = worldPoint(matched.get(children[0]).from).sub(worldPoint(entry.from)).normalize();
    entry.align.setFromUnitVectors(along, fromAlong);
  }

  const hips = hero.getObjectByName(heroHips);
  const fromHips = matched.get(hips).from;
  const hipsRest = worldPoint(hips);
  const fromHipsRest = worldPoint(fromHips);
  const heightRatio = hipsRest.y / fromHipsRest.y;

  const mixer = new THREE.AnimationMixer(source);
  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * SAMPLE_RATE) + 1);
  const times = [];
  const hipsValues = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const time = (clip.duration * frame) / (frames - 1);
    times.push(time);
    mixer.setTime(Math.min(time, clip.duration - 1e-4));
    source.updateMatrixWorld(true);
    const wanted = new Map();
    hero.traverse((bone) => {
      const parentTurn = wanted.get(bone.parent) ?? (bone.parent ? worldTurn(bone.parent) : new THREE.Quaternion());
      const entry = matched.get(bone);
      if (!entry) {
        wanted.set(bone, parentTurn.clone().multiply(bone.quaternion));
        return;
      }
      const turn = worldTurn(entry.from).multiply(entry.fromRest.clone().invert()).multiply(entry.align).multiply(entry.rest);
      wanted.set(bone, turn);
      entry.values.push(...parentTurn.clone().invert().multiply(turn).toArray());
    });
    const travelled = worldPoint(fromHips).sub(fromHipsRest).multiplyScalar(heightRatio);
    hipsValues.push(...hips.parent.worldToLocal(travelled.add(hipsRest)).toArray());
  }
  action.stop();
  mixer.uncacheRoot(source);

  const tracks = [...matched].map(([bone, entry]) => new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, entry.values));
  tracks.push(new THREE.VectorKeyframeTrack(`${heroHips}.position`, times, hipsValues));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** The mannequin's bone (as GLTFLoader spells it) for each body bone of a Genex character. */
export const MANNEQUIN_FOR_GENEX = { Hips: "DEF-hips", Spine02: "DEF-spine001", Spine01: "DEF-spine002", Spine: "DEF-spine003", neck: "DEF-neck", Head: "DEF-head" };
for (const [side, letter] of [
  ["Left", "L"],
  ["Right", "R"],
]) {
  Object.assign(MANNEQUIN_FOR_GENEX, {
    [`${side}Shoulder`]: `DEF-shoulder${letter}`,
    [`${side}Arm`]: `DEF-upper_arm${letter}`,
    [`${side}ForeArm`]: `DEF-forearm${letter}`,
    [`${side}Hand`]: `DEF-hand${letter}`,
    [`${side}UpLeg`]: `DEF-thigh${letter}`,
    [`${side}Leg`]: `DEF-shin${letter}`,
    [`${side}Foot`]: `DEF-foot${letter}`,
    [`${side}ToeBase`]: `DEF-toe${letter}`,
  });
}
