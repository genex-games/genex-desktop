"""Prints what the Genex editor helper's probes answer for one broken scene, as the editor queue
hands it back ({characters, view}), so a TypeScript test can read it the way the judge's lines do:
the player's off-road car sliding sideways with a handlebar through the near plane, a mutant whose
mesh floats over its capsule, and a volume with extreme motion blur."""

import json
import os
import tempfile

import unreal
from unreal import Rotator, Vector

from genex_loop.tools import GenexLoopTools

CUBE = unreal.StaticMesh(Vector(-50, -50, -50), Vector(50, 50, 50))
EYE = Vector(0, 0, 160)

unreal.reset(os.path.realpath(tempfile.gettempdir()))
unreal.state['pie'] = True
unreal.state['floors'] = [unreal.Floor(0.0)]

body = unreal.SkeletalMeshComponent('VehicleMesh', {'wheel_fl': Vector(100, -80, 35), 'roof': Vector(0, 0, 150)}, visible=False)
car = unreal.WheeledVehiclePawn('BP_OffroadCar_0', Vector(0, 0, 90), body, contacts=[True, True, True, True])
car.velocity = Vector(600, 900, 0)
car.components += [unreal.CameraComponent('FrontCamera', EYE),
                   unreal.StaticMeshComponent('Handlebar', CUBE, Vector(10, 0, 158), scale=Vector(0.08, 0.6, 0.04))]
mutant = unreal.Character('Mutant_0', Vector(500, 0, 88), unreal.SkeletalMeshComponent(
    'CharacterMesh0', {'foot_l': Vector(500, -10, 40), 'head': Vector(500, 0, 210)}))
blur = unreal.PostProcessVolume('PP_Global', unreal.PostProcessSettings(override_motion_blur_amount=True, motion_blur_amount=1.0))
unreal.state['actors'] = [car, mutant, blur]
unreal.state['player'] = car
unreal.state['camera'] = unreal.PlayerCameraManager(EYE, Rotator(), 90.0, car)

print(json.dumps({'characters': json.loads(GenexLoopTools.probe_characters('')),
                  'view': json.loads(GenexLoopTools.probe_view())}))
