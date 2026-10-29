# Elide only the bulky, irrelevant parts of a real `pi --mode json` recording:
# the system message_start/message_end (Pi's own system prompt + tool schemas), agent_end.messages,
# and the absolute cwd. Every other field and every event is kept verbatim and in order.
import json,sys
for line in open(sys.argv[1]):
    e=json.loads(line)
    if e.get("type") in ("message_start","message_end") and e.get("message",{}).get("role")=="system":
        e["message"]={"role":"system","content":"","sections":"<elided: Pi system prompt>","timestamp":e["message"].get("timestamp")}
    if e.get("type")=="agent_end": e["messages"]="<elided>"
    if e.get("type")=="session": e["cwd"]="/game"
    print(json.dumps(e,separators=(",",":"),ensure_ascii=False))
