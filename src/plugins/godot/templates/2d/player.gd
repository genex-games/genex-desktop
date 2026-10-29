extends CharacterBody2D
## The player: moves with the arrow keys or WASD.

const SPEED := 300.0


func _physics_process(_delta: float) -> void:
	velocity = Input.get_vector("move_left", "move_right", "move_up", "move_down") * SPEED
	move_and_slide()
