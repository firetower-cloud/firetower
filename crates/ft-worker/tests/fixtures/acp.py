"""A deterministic ACP peer; no model, credentials or tool execution."""
import json, sys
scenario = sys.argv[1]
active = None

def emit(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

for line in sys.stdin:
    m = json.loads(line)
    method = m.get("method")
    if method == "initialize":
        emit({"id": m["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": scenario != "no-load"}}})
    elif method == "session/new":
        if scenario == "auth":
            emit({"id": m["id"], "error": {"code": -32000, "message": "Authentication required"}})
        else:
            emit({"id": m["id"], "result": {"sessionId": "fixture-session"}})
    elif method == "session/load":
        if scenario == "missing":
            emit({"id":m["id"], "error":{"code":-32602,"message":"Invalid params: Unknown sessionId: old-session","data":{"sessionId":"old-session"}}})
        elif scenario == "load-auth":
            emit({"id":m["id"], "error":{"code":-32000,"message":"Authentication required"}})
        else:
            emit({"method":"session/update","params":{"sessionId":m["params"]["sessionId"],"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old replay"}}}})
            emit({"id":m["id"], "result":{}})
    elif method == "session/prompt":
        active = m["id"]
        if scenario == "malformed":
            print("not json", flush=True)
        elif scenario == "exit":
            sys.exit(1)
        elif scenario == "permission":
            emit({"id":"permit-1","method":"session/request_permission","params":{"sessionId":m["params"]["sessionId"],"toolCall":{"toolCallId":"tool-1","title":"read a file"},"options":[{"kind":"allow_once","optionId":"yes"},{"kind":"reject_once","optionId":"no"}]}})
        elif scenario != "cancel":
            emit({"method":"session/update","params":{"sessionId":m["params"]["sessionId"],"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello back"}}}})
            emit({"id":active,"result":{"stopReason":"end_turn"}})
            active = None
    elif method == "session/cancel":
        emit({"id":active,"result":{"stopReason":"cancelled"}})
        active = None
    elif method == "session/set_config_option":
        if scenario == "configure-hold":
            continue
        if m["params"]["value"] == "refused":
            emit({"id":m["id"], "error":{"code":-32602,"message":"Model unavailable"}})
        else:
            emit({"id":m["id"], "result":{"configOptions":[{"id":"thinking","category":"thought_level","name":"Thinking","type":"select","currentValue":m["params"]["value"],"options":[{"value":"low","name":"Low"}]}]}})
    elif method is None and m.get("id") == "permit-1":
        emit({"id":active,"result":{"stopReason":"end_turn"}})
        active = None
