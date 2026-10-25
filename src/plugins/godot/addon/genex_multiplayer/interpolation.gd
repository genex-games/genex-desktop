extends RefCounted
## Remote smoothing on the SENDER's clock: PROTOCOL.md §10 (and §10.1 for posed players).
##
## A stream is one remote player ("p:<sid>") or one object ("o:<id>"). Samples are stamped
## by their sender (`__t`, an object's `t`, a pose's `poseT`); an unstamped sample must never
## be pushed. Clock offsets belong to the SENDER, so every stream of one machine shares one.
## Port of the TypeScript SDK's pushSnap / sampleSmoothed / samplePose.

const P = preload("res://addons/genex_multiplayer/protocol.gd")


class SenderClock extends RefCounted:
	var samples: Array = [] # [arrival_ms, n]
	var mins: Array = [] # monotonic deque of [value, n]; mins[0] is the window minimum
	var n := 0


class Stream extends RefCounted:
	var buf: Array = [] # [{t, state}], ascending sender time
	var has_last := false
	var last_stamp := 0.0
	var sender := ""
	var has_sender := false
	var gaps: Array = []
	var delay := P.INTERP_DEFAULT_MS
	var jitter: Array = []
	var smoothed = null # last eased output (Dictionary) or null
	var smoothed_at := 0.0
	var bridge = null # pending handoff bridge pose
	var posed := false

	func clear_clock() -> void:
		buf.clear()
		has_last = false
		has_sender = false
		gaps.clear()
		delay = P.INTERP_DEFAULT_MS
		jitter.clear()


var clocks := {} # sender -> SenderClock
var offsets := {} # sender -> float (local - sender clock, min-filtered)
var streams := {} # key -> Stream


func _stream(key: String) -> Stream:
	var s: Stream = streams.get(key)
	if s == null:
		s = Stream.new()
		streams[key] = s
	return s


func has_stream(key: String) -> bool:
	return streams.has(key)


## Feed one stamped sample. `s` is the sender clock stamp (ms), `now` the local clock (ms).
func push(key: String, sender: String, s: float, state: Dictionary, now: float, posed := false) -> void:
	var st := _stream(key)
	st.posed = posed
	var sample := now - s
	var sc: SenderClock = clocks.get(sender)
	if sc == null:
		sc = SenderClock.new()
		clocks[sender] = sc
	sc.n += 1
	var n := sc.n
	sc.samples.append([now, n])
	while sc.mins.size() > 0 and sc.mins[sc.mins.size() - 1][0] >= sample:
		sc.mins.pop_back()
	sc.mins.append([sample, n])
	# Keep at least CLOCK_WINDOW samples AND at least CLOCK_WINDOW_MS of them (§10 step 1).
	while sc.samples.size() > P.CLOCK_WINDOW_MAX or (sc.samples.size() > P.CLOCK_WINDOW and sc.samples[0][0] < now - P.CLOCK_WINDOW_MS):
		sc.samples.pop_front()
	var first_kept: int = sc.samples[0][1]
	while sc.mins[0][1] < first_kept:
		sc.mins.pop_front()
	var offset: float = sc.mins[0][0]
	offsets[sender] = offset

	st.jitter.append(sample)
	if st.jitter.size() > P.CLOCK_WINDOW:
		st.jitter.pop_front()
	st.sender = sender
	st.has_sender = true

	# §10 step 2: render delay self-tunes per stream.
	if st.has_last:
		var gap := s - st.last_stamp
		if gap > P.MIN_GAP_MS and gap < P.MAX_GAP_MS:
			st.gaps.append(gap)
			if st.gaps.size() > P.INTERVAL_WINDOW:
				st.gaps.pop_front()
			var jit := 0.0
			if st.jitter.size() >= 8:
				jit = maxf(0.0, _quantile(st.jitter, 0.9) - offset)
			var target := minf(P.INTERP_MAX_MS, maxf(P.INTERP_MIN_MS, maxf(P.INTERP_RATIO * _median(st.gaps), P.INTERP_JITTER_SAFETY * jit)))
			st.delay += (target - st.delay) * P.INTERP_EASE
	st.has_last = true
	st.last_stamp = s

	# §10 step 6: consume a soft-handoff bridge on the new owner's first sample.
	if st.bridge != null and st.buf.is_empty():
		st.buf.append({"t": s - maxf(1.0, st.delay), "state": st.bridge})
	st.bridge = null
	st.buf.append({"t": s, "state": state})
	# §10 step 3: keep HISTORY_MS, never fewer than 2; drop a foreign-clock head.
	var cutoff := s - P.HISTORY_MS
	while st.buf.size() > 2 and st.buf[0].t < cutoff:
		st.buf.pop_front()
	while st.buf.size() > 1 and st.buf[0].t > st.buf[st.buf.size() - 1].t + P.POISON_GUARD_MS:
		st.buf.pop_front()


## The smoothed output of a stream at local time `now`, or null when it has nothing yet.
func sample(key: String, now: float):
	var st: Stream = streams.get(key)
	if st == null:
		return null
	var render_time := now - P.INTERP_DEFAULT_MS
	if st.has_sender and offsets.has(st.sender):
		render_time = now - float(offsets[st.sender]) - st.delay
	var sampled = null
	if not st.buf.is_empty():
		sampled = sample_pose(st.buf, render_time) if st.posed else sample_buffer(st.buf, render_time)
	if sampled == null:
		return st.smoothed
	var out: Dictionary
	if st.smoothed != null:
		var dt := clampf(now - st.smoothed_at, 0.0, P.MAX_DT_MS)
		var a_pos := 1.0 - exp(-dt / P.SMOOTH_TAU_POS_MS)
		var a_rot := 1.0 - exp(-dt / P.SMOOTH_TAU_ROT_MS)
		out = ease_pose(st.smoothed, sampled, a_pos, a_rot) if st.posed else ease_state(st.smoothed, sampled, a_pos, a_rot)
	else:
		out = sampled
	st.smoothed = out
	st.smoothed_at = now
	return out


## The current render delay of a stream (ms), for diagnostics.
func delay_of(key: String) -> float:
	var st: Stream = streams.get(key)
	return st.delay if st != null else P.INTERP_DEFAULT_MS


## Ownership moved (§10 step 6): new clock domain, keep the on-screen pose as a bridge.
func soft_handoff(key: String, fallback) -> void:
	var st := _stream(key)
	st.clear_clock()
	st.bridge = st.smoothed if st.smoothed != null else fallback


## A deliberate discontinuity (an epoch change): drop history and place the stream at `state`.
func reseed(key: String, state, now: float) -> void:
	var st := _stream(key)
	st.clear_clock()
	st.bridge = null
	st.smoothed = state
	st.smoothed_at = now


## True teardown: a player left or an object was destroyed.
func clear(key: String) -> void:
	streams.erase(key)


## The sender's seat is gone: forget its clock estimate.
func drop_sender(sender: String) -> void:
	clocks.erase(sender)
	offsets.erase(sender)


## One deliberate rebase after a long outage (§8 step 2): discard every stream and clock.
func rebase() -> void:
	streams.clear()
	clocks.clear()
	offsets.clear()


# ---- sampling (§10 step 4) ----

static func sample_buffer(buf: Array, r: float):
	var n := buf.size()
	if n == 0:
		return null
	if n == 1:
		return buf[0].state
	var j := 0
	while j < n and buf[j].t <= r:
		j += 1
	if j == 0:
		return buf[0].state
	if j >= n:
		var a = buf[n - 2]
		var b = buf[n - 1]
		var span: float = b.t - a.t
		if span <= 0.0:
			return b.state
		var t_pos: float = (minf(r, b.t + P.MAX_EXTRAP_MS) - a.t) / span
		var t_rot: float = (minf(r, b.t + P.ROT_EXTRAP_MS) - a.t) / span
		return blend(a.state, b.state, t_pos, t_rot)
	var a2 = buf[j - 1]
	var b2 = buf[j]
	var span2: float = b2.t - a2.t
	var k: float = (r - a2.t) / span2 if span2 > 0.0 else 1.0
	return blend(a2.state, b2.state, k, k)


static func blend(a: Dictionary, b: Dictionary, t_num: float, t_quat: float) -> Dictionary:
	var out := {}
	var interpolating := t_num < 1.0
	for k in b:
		var av = a.get(k)
		var bv = b[k]
		if _is_num(av) and _is_num(bv):
			out[k] = float(av) + (float(bv) - float(av)) * t_num
		elif _is_quat(av) and _is_quat(bv):
			out[k] = slerp(av, bv, t_quat)
		else:
			out[k] = av if (interpolating and a.has(k)) else bv
	return out


static func ease_state(prev: Dictionary, target: Dictionary, a_num: float, a_quat: float) -> Dictionary:
	var out := {}
	for k in target:
		var tv = target[k]
		var pv = prev.get(k)
		if _is_num(pv) and _is_num(tv):
			out[k] = float(pv) + (float(tv) - float(pv)) * a_num
		elif _is_quat(pv) and _is_quat(tv):
			out[k] = slerp(pv, tv, a_quat)
		else:
			out[k] = tv
	return out


## Quaternion [x,y,z,w] slerp along the shortest arc; t > 1 extrapolates along the same arc.
static func slerp(a: Array, b: Array, t: float) -> Array:
	var ax: float = a[0]; var ay: float = a[1]; var az: float = a[2]; var aw: float = a[3]
	var bx: float = b[0]; var by: float = b[1]; var bz: float = b[2]; var bw: float = b[3]
	var dot := ax * bx + ay * by + az * bz + aw * bw
	if dot < 0.0:
		bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot
	if dot > 0.9995:
		var x := ax + (bx - ax) * t
		var y := ay + (by - ay) * t
		var z := az + (bz - az) * t
		var w := aw + (bw - aw) * t
		var l := sqrt(x * x + y * y + z * z + w * w)
		if l == 0.0:
			l = 1.0
		return [x / l, y / l, z / l, w / l]
	var theta0 := acos(dot)
	var sin0 := sin(theta0)
	var s0 := sin(theta0 - theta0 * t) / sin0
	var s1 := sin(theta0 * t) / sin0
	return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1]


# ---- §10.1 posed players ----

static func wrap_angle(a: float) -> float:
	if not is_finite(a):
		return 0.0
	var r := fmod(a, TAU)
	if r <= -PI:
		r += TAU
	elif r > PI:
		r -= TAU
	return r


static func sample_pose(buf: Array, r: float):
	var n := buf.size()
	if n == 0:
		return null
	var j := 0
	while j < n and buf[j].t <= r:
		j += 1
	if j == 0:
		return buf[0].state
	if j >= n:
		var b = buf[n - 1]
		var out: Dictionary = b.state.duplicate()
		var ahead := minf(maxf(0.0, r - b.t), P.MAX_EXTRAP_MS) / 1000.0
		for axis in [["x", "vx"], ["y", "vy"], ["z", "vz"]]:
			out[axis[0]] = _num(b.state, axis[0]) + _num(b.state, axis[1]) * ahead
		if n >= 2:
			var a = buf[n - 2]
			var span: float = b.t - a.t
			if span > 0.0:
				var k := minf(maxf(0.0, r - b.t), P.ROT_EXTRAP_MS) / span
				var yb := _num(b.state, "yaw")
				out["yaw"] = yb + wrap_angle(yb - _num(a.state, "yaw")) * k
		return out
	var a2 = buf[j - 1]
	var b2 = buf[j]
	var span2: float = b2.t - a2.t
	var k2: float = (r - a2.t) / span2 if span2 > 0.0 else 1.0
	var out2: Dictionary = a2.state.duplicate()
	for key in P.POSE_NUMERIC_KEYS:
		var va := _num(a2.state, key)
		var vb := _num(b2.state, key)
		out2[key] = va + wrap_angle(vb - va) * k2 if key == "yaw" else va + (vb - va) * k2
	return out2


static func ease_pose(prev: Dictionary, target: Dictionary, a_pos: float, a_rot: float) -> Dictionary:
	var out: Dictionary = target.duplicate()
	for key in P.POSE_NUMERIC_KEYS:
		var pv = prev.get(key)
		var tv = target.get(key)
		if not (_is_num(pv) and _is_num(tv)):
			continue
		out[key] = float(pv) + wrap_angle(float(tv) - float(pv)) * a_rot if key == "yaw" else float(pv) + (float(tv) - float(pv)) * a_pos
	return out


# ---- helpers ----

static func _is_num(v) -> bool:
	var ty := typeof(v)
	return (ty == TYPE_FLOAT and is_finite(v)) or ty == TYPE_INT


static func _is_quat(v) -> bool:
	if typeof(v) != TYPE_ARRAY or v.size() != 4:
		return false
	for e in v:
		if not _is_num(e):
			return false
	return true


static func _num(o: Dictionary, k: String) -> float:
	var v = o.get(k)
	return float(v) if _is_num(v) else 0.0


static func _median(xs: Array) -> float:
	if xs.is_empty():
		return 66.0
	var s := xs.duplicate()
	s.sort()
	return s[s.size() >> 1]


static func _quantile(xs: Array, q: float) -> float:
	if xs.is_empty():
		return 0.0
	var s := xs.duplicate()
	s.sort()
	var i := clampi(roundi(q * (s.size() - 1)), 0, s.size() - 1)
	return s[i]
