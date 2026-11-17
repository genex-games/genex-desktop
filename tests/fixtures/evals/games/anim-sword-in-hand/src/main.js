// A mannequin holds a sword stance in a yard. It has no sword yet.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createStage } from "./stage.js";

const stage = createStage();
const hero = await new GLTFLoader().loadAsync("/assets/hero.glb");
stage.scene.add(hero.scene);
const mixer = new THREE.AnimationMixer(hero.scene);
mixer.clipAction(THREE.AnimationClip.findByName(hero.animations, "Sword_Idle")).play();
stage.run((seconds) => mixer.update(seconds));
