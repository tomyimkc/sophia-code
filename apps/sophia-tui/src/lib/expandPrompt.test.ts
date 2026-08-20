import test from "node:test";
import assert from "node:assert/strict";
import { allCommands, expandPromptCommand, type SlashCommand } from "./slash.js";

const cmd = (over: Partial<SlashCommand> = {}): SlashCommand =>
  ({ name: "review", description: "", category: "", kind: "prompt", support_state: "supported",
     execution_state: "prompt", aliases: [], hint: "", collapse_chat: false,
     prompt_template: "Review this: {args}", target: "", slash: "/review", ...over }) as SlashCommand;

test("the template is filled with the operator's args", () => {
  assert.equal(expandPromptCommand(cmd(), "the bridge"), "Review this: the bridge");
});

test("every {args} occurrence is filled, not just the first", () => {
  const c = cmd({ prompt_template: "{args} — and again: {args}" });
  assert.equal(expandPromptCommand(c, "x"), "x — and again: x");
});

test("empty args become an explicit instruction, not an empty hole", () => {
  // "Review this: " with nothing after it reads as a truncated prompt; the
  // model needs to be told to look at the repo instead.
  assert.equal(expandPromptCommand(cmd(), ""), "Review this: (see repository state)");
  assert.equal(expandPromptCommand(cmd(), "   "), "Review this:    ");
});

test("a command with no template still produces a usable goal", () => {
  const c = cmd({ name: "audit", prompt_template: "" });
  const out = expandPromptCommand(c, "the gate");
  assert.match(out, /\/audit/);
  assert.match(out, /the gate/);
});

test("a '$' in the args survives verbatim — it used to corrupt the goal", () => {
  // String.replace interprets $&, $`, $' and $$ INSIDE the replacement, i.e.
  // inside whatever the operator typed. Measured on the old implementation:
  //   "cost $& more" -> "cost {args} more"    their text replaced by the token
  //   "a $` b"       -> "a Review this:  b"   TEMPLATE text leaked into theirs
  //   "x $' y"       -> "x  y"                text silently dropped
  // '$' is ordinary in shell commands, prices and regexes, so this quietly
  // rewrote the goal actually sent to the model.
  for (const args of ["cost $& more", "a $` b", "x $' y", "$$1", "awk '{print $1}'", "US$5"]) {
    assert.equal(expandPromptCommand(cmd(), args), `Review this: ${args}`,
      `args ${JSON.stringify(args)} was not preserved verbatim`);
  }
});

test("braces in the args are not re-expanded", () => {
  // A literal "{args}" typed by the operator must stay literal — otherwise a
  // second pass could substitute it, which is how the $& case leaked.
  assert.equal(expandPromptCommand(cmd(), "{args}"), "Review this: {args}");
});

test("every prompt command in the shipped catalog expands to something usable", () => {
  const prompts = allCommands().filter((c) => c.kind === "prompt");
  assert.ok(prompts.length >= 10, `expected the catalog's prompt commands, got ${prompts.length}`);
  for (const c of prompts) {
    const out = expandPromptCommand(c, "SENTINEL-ARG");
    assert.ok(out.trim().length > 0, `/${c.name} expanded to nothing`);
    assert.ok(out.includes("SENTINEL-ARG"),
      `/${c.name} dropped the operator's args entirely: ${out.slice(0, 120)}`);
    assert.ok(!out.includes("{args}"),
      `/${c.name} left an unsubstituted {args}: ${out.slice(0, 120)}`);
  }
});
