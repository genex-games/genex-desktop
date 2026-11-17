// A barbarian stands in a yard and plays his idle clip.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createStage } from "./stage.js";

const stage = createStage();
const loader = new GLTFLoader();
const [hero, idle] = await Promise.all([loader.loadAsync("/assets/hero.glb"), loader.loadAsync("/assets/hero-idle.glb")]);
stage.scene.add(hero.scene);
const mixer = new THREE.AnimationMixer(hero.scene);
mixer.clipAction(idle.animations[0]).play();
stage.run((seconds) => mixer.update(seconds));
