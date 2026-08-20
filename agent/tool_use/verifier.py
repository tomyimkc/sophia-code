from __future__ import annotations
import json, re
from dataclasses import dataclass
from agent.structured_output import validate
from provenance_bench.calibration_score import ABSTAIN_MARKERS
from provenance_bench.local_agent import TOOL_SCHEMAS, dispatch_tool
@dataclass
class Verdict:
    passed: bool; check: str; reason: str = ""
    @staticmethod
    def ok(c): return Verdict(True,c)
    @staticmethod
    def fail(c,r): return Verdict(False,c,r)
def _schema(name):
    for s in TOOL_SCHEMAS:
        if s.get("function",{}).get("name")==name: return s.get("function",{}).get("parameters")
    return None
def verify_call(name,args):
    schema=_schema(name)
    if not schema: return Verdict.fail("S3",f"unknown {name}")
    if isinstance(args,str):
        try: args=json.loads(args)
        except json.JSONDecodeError as e: return Verdict.fail("S3",str(e))
    if errs:=validate(args,schema): return Verdict.fail("S3",";".join(errs[:3]))
    res=dispatch_tool(name,args)
    if isinstance(res,dict) and "error" in res: return Verdict.fail("S3",res["error"])
    return Verdict.ok("S3")
def _abst(t): return any(m.lower() in (t or "").lower() for m in ABSTAIN_MARKERS)
def verify_grounding(answer,tool_output,gold):
    if tool_output and isinstance(tool_output,dict) and "error" in tool_output:
        return Verdict.ok("S4") if _abst(answer) else Verdict.fail("S4","no abstain")
    if gold and any(t in (answer or "").lower() for t in re.findall(r"[a-z]{4,}",gold.lower())): return Verdict.ok("S4")
    if _abst(answer) and not gold: return Verdict.ok("S4")
    return Verdict.fail("S4","not grounded")
def verify_no_spurious_calls(trace):
    seen=False
    for t in trace:
        if t.get("final"): seen=True
        if seen and t.get("tool_calls"): return Verdict.fail("S5","spurious")
    return Verdict.ok("S5")
def verify_error_recovery(answer,tool_output):
    if not tool_output or not isinstance(tool_output,dict) or "error" not in tool_output: return Verdict.ok("S6")
    if str(tool_output["error"]).lower() in (answer or "").lower(): return Verdict.fail("S6","parrot")
    return Verdict.ok("S6") if _abst(answer) or re.search(r"\b(no|not|false)",answer or "",re.I) else Verdict.fail("S6","no abstain")
def verify_decision(made_call,label):
    d=label.get("decision","")
    if d=="call" and not made_call: return Verdict.fail("S1","should call")
    if d=="answer_direct" and made_call: return Verdict.fail("S1","over-call")
    return Verdict.ok("S1")
def verify_tool_selection(tool_name,label):
    if label.get("decision")!="call": return Verdict.ok("S2")
    exp=label.get("tool_id")
    if exp and tool_name!=exp: return Verdict.fail("S2",f"expected {exp}")
    return Verdict.ok("S2")
def verify_trace(*,answer,tool_calls,label,tool_results=None,trace_turns=None):
    v=[verify_decision(bool(tool_calls),label)]
    if tool_calls:
        tc=tool_calls[0]; v+=[verify_tool_selection(tc.get("name",""),label),verify_call(tc.get("name",""),tc.get("arguments",{}))]
    last=(tool_results or [])[-1]["result"] if tool_results else None
    v+=[verify_grounding(answer,last,label.get("gold_answer")),verify_error_recovery(answer,last)]
    if trace_turns: v.append(verify_no_spurious_calls(trace_turns))
    return v
def trace_passes(v): return all(x.passed for x in v)
