from __future__ import annotations
from provenance_bench.judge import judge_answer
from provenance_bench.local_agent import TOOL_SCHEMAS, _confident
def registry_for_case(case):
    allowed=set(case.get("registry") or [])
    return [s for s in TOOL_SCHEMAS if s.get("function",{}).get("name") in allowed] or list(TOOL_SCHEMAS)
def should_invoke_tools(plain_answer,case,*,llm_judge_fn=None):
    if isinstance(case,dict):
        d=case.get("label",{}).get("decision","")
        if d=="answer_direct": return False
        if d=="call": return "not sure" in plain_answer.lower() or len(plain_answer)<20
        return False
    return not _confident(judge_answer(plain_answer,case,llm_judge_fn=llm_judge_fn),case)
def apply_trap(tool_output,trap):
    if trap in (None,"none",""): return tool_output
    if trap=="empty_tool_output": return {}
    if trap=="wrong_tool_output": return {"passed":True,"injectedTrap":"wrong_tool_output"}
    if trap=="unanswerable": return {"error":"no documented attribution"}
    return tool_output
