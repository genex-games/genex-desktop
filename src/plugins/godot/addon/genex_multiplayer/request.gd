extends RefCounted
## One object control request (claim / release / destroy), PROTOCOL.md §7.2.
##
##   var req = GenexMultiplayer.claim("ball")
##   var result: Dictionary = await req.done
##   if result.accepted: ...
##
## `result` mirrors `__object:result`: {requestId, operation, id, accepted, owner, sequence,
## reason, retryAfterMs}. Two client-side reasons exist: "timeout" (the outcome is UNKNOWN,
## the relay may have applied it; trust the object's owner instead) and "disconnected".

signal done(result: Dictionary)

var request_id := ""
var operation := "" # "claim" | "release" | "remove"
var object_id := ""
var payload := {}
var optimistic := false
var deadline_ms := 0.0
var settled := false
var result := {}


func settle(r: Dictionary) -> void:
	if settled:
		return
	settled = true
	result = r
	done.emit(r)
