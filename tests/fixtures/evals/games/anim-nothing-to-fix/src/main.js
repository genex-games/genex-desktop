// A barbarian walks on the spot in a yard, with a walk that was made for a mannequin.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createStage } from "./stage.js";
import { MANNEQUIN_FOR_GENEX, transferClip } from "./transfer.js";

const stage = createStage();
const loader = new GLTFLoader();
const [hero, walk] = await Promise.all([loader.loadAsync("/assets/hero.glb"), loader.loadAsync("/assets/walk.glb")]);
stage.scene.add(hero.scene);
// The walk's skeleton has other bone names, another resting pose and other bone lengths, so the
// clip is carried over to the hero while he is still in his rest pose.
const clip = transferClip(walk.animations[0], walk.scene, hero.scene, "Hips", (bone) => MANNEQUIN_FOR_GENEX[bone], ["LeftFoot", "RightFoot"]);
const mixer = new THREE.AnimationMixer(hero.scene);
mixer.clipAction(clip).play();
stage.run((seconds) => mixer.update(seconds));
