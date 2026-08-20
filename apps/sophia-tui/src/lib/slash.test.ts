import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  allCommands,
  categoryLabel,
  clientExecutionFor,
  clientRegistryParity,
  chooseSlashSubmission,
  commandAcceptsArguments,
  commandBadges,
  commandsForEdition,
  commandUsage,
  completeSlashSelection,
  editionAllowsCommand,
  editionUnavailableMessage,
  planSlashCommandPaste,
  productDefaults,
  productProfile,
  productProfileSummary,
  rankSlashMatches,
  resolve,
  suggest,
} from "./slash.js";
import type { SlashCommand } from "./slash.js";

// These tests lock the slash-catalog contracts that App.tsx relies on but could
// not previously test: resolve() / suggest() are pure, and chooseSlashSubmission
// is the extracted decision behind onSlashEnterSelect (the "typed /resume name
// is preserved on Enter" path). The full <App> cannot be rendered in a test
// (it spawns a real bridge subprocess with no DI seam), so the pure decision is
// tested here instead of via an Ink render.

test("catalog loads with the documented guard properties", () => {
  const cmds = allCommands();
  // The catalog is generated from agent/slash_catalog.py; assert a populated,
  // non-trivial set without pinning an exact count (commands are added over time).
  assert.ok(cmds.length > 50, "catalog should be populated");
  // /resume and /effort must exist for the paths under test.
  assert.ok(cmds.some((c) => c.name === "resume"));
  assert.ok(cmds.some((c) => c.name === "effort"));
  assert.ok(cmds.some((c) => c.name === "contract"));
  assert.ok(cmds.some((c) => c.name === "tools"));
  assert.ok(!cmds.some((c) => c.name === "team"));
  assert.ok(!cmds.some((c) => c.name === "auto-dispatch"));
  assert.ok(!cmds.some((c) => c.name === "fable"));
  assert.equal(categoryLabel("sophia"), "Sophia");
  assert.equal(productDefaults().canClaimAGI, false);
});

test("oss edition hides conscience, effort, agi, a2a, workflow, and flow surfaces", () => {
  const names = new Set(commandsForEdition("oss").map((c) => c.name));
  for (const blocked of [
    "conscience",
    "effort",
    "ultramode",
    "a2a",
    "workflow",
    "agi",
    "graph",
    "goal",
    "panel",
  ]) {
    assert.equal(names.has(blocked), false, blocked);
  }
  assert.equal(names.has("model"), true);
  assert.equal(names.has("permissions"), true);
  assert.equal(names.has("plan"), true);
  assert.equal(names.has("login"), true);
  assert.equal(names.has("setup"), true);
  assert.equal(editionUnavailableMessage("workflow").includes("/workflow"), true);
  assert.equal(editionUnavailableMessage("agi").includes("AGI"), false);
  const previous = process.env.SOPHIA_EDITION;
  process.env.SOPHIA_EDITION = "oss";
  try {
    assert.equal(editionAllowsCommand("workflow"), false);
    assert.equal(editionAllowsCommand("panel"), false);
    assert.equal(editionAllowsCommand("model"), true);
  } finally {
    if (previous === undefined) delete process.env.SOPHIA_EDITION;
    else process.env.SOPHIA_EDITION = previous;
  }
});

test("resolve: /resume tui-default preserves the session-name arg", () => {
  // This is the exact contract onSlashEnterSelect relies on: a typed line that
  // already resolves must be submitted verbatim so args survive.
  const r = resolve("/resume tui-default");
  assert.ok(r.cmd, "expected /resume to resolve to a known command");
  assert.equal(r.name, "resume");
  assert.equal(r.args, "tui-default");
});

test("resolve: workflow resume preserves the explicit source run id", () => {
  const r = resolve("/workflow resume crashed-workflow-123");
  assert.ok(r.cmd, "expected /workflow to resolve to a known command");
  assert.equal(r.name, "workflow");
  assert.equal(r.args, "resume crashed-workflow-123");
  assert.match(commandUsage(r.cmd), /resume <run-id>/);
  assert.equal(r.cmd.arguments?.custom_parser, true);
});

test("resolve preserves repeated whitespace inside exact session names", () => {
  const r = resolve("/resume multi   spaces");
  assert.equal(r.name, "resume");
  assert.equal(r.args, "multi   spaces");
});

test("resolve: bare slash and non-slash lines do not resolve", () => {
  assert.equal(resolve("/").cmd, null);
  assert.equal(resolve("").cmd, null);
  assert.equal(resolve("hello").cmd, null);
  assert.equal(resolve("not a slash").name, "");
});

test("multi-line local settings paste is split before /model can swallow later commands", () => {
  assert.deepEqual(
    planSlashCommandPaste(
      "/model codex\n/runtime sophia\n/permissions readonly\n/a2a auto",
    ),
    {
      kind: "batch",
      commands: [
        "/model codex",
        "/runtime sophia",
        "/permissions readonly",
        "/a2a auto",
      ],
    },
  );
});

test("slash settings paste normalizes CRLF and surrounding whitespace", () => {
  assert.deepEqual(
    planSlashCommandPaste("  /model codex\r\n\r\n /effort medium \r\n /deepmode off  "),
    {
      kind: "batch",
      commands: ["/model codex", "/effort medium", "/deepmode off"],
    },
  );
});

test("ordinary multi-line prompts remain ordinary prompts", () => {
  assert.equal(
    planSlashCommandPaste("Review this configuration:\n/model codex\nDo not execute it."),
    null,
  );
});

test("mixed slash-command and prompt paste is rejected instead of becoming a model alias", () => {
  const plan = planSlashCommandPaste("/model codex\nNow inspect the repository.");
  assert.equal(plan?.kind, "reject");
  assert.match(plan?.kind === "reject" ? plan.reason : "", /prompt text/);
});

test("prompt-producing slash commands are not silently executed inside a settings batch", () => {
  const plan = planSlashCommandPaste("/model codex\n/logic strict\n/a2a off");
  assert.equal(plan?.kind, "reject");
  assert.match(plan?.kind === "reject" ? plan.reason : "", /\/logic.*run it separately/);
});

test("unknown slash commands reject the complete pasted block", () => {
  const plan = planSlashCommandPaste("/model codex\n/not-a-command on");
  assert.equal(plan?.kind, "reject");
  assert.match(plan?.kind === "reject" ? plan.reason : "", /unknown slash command/);
});

test("resolve: alias resolves to the canonical command name", () => {
  // /ultramode advertises the "ultra" alias; resolve must map it back.
  const r = resolve("/ultra");
  assert.ok(r.cmd);
  assert.equal(r.name, "ultramode");
});

test("retired Team commands no longer resolve", () => {
  assert.equal(resolve("/team on").cmd, null);
  assert.equal(resolve("/auto-dispatch on").cmd, null);
});

test("fallback-model is an honest local command with status/set/off/return-main syntax", () => {
  const direct = resolve("/fallback-model ollama:qwen3:30b-a3b");
  const alias = resolve("/semantic-fallback status");
  assert.ok(direct.cmd && alias.cmd);
  assert.equal(direct.name, "fallback-model");
  assert.equal(direct.args, "ollama:qwen3:30b-a3b");
  assert.equal(alias.name, "fallback-model");
  assert.equal(alias.args, "status");
  assert.equal(clientExecutionFor(direct.cmd, "tui").execution_state, "implemented_local");
  assert.match(commandUsage(direct.cmd), /return-main on\|off/);
  assert.match(direct.cmd.description, /local recovery/);
});

test("the historical /fable alias is not active", () => {
  assert.equal(resolve("/fable").cmd, null);
  const contract = resolve("/contract");
  assert.ok(contract.cmd);
  assert.match(contract.cmd.description, /compact Sophia runtime policy/);
});

test("suggest: /effort surfaces the effort command ranked first", () => {
  const matches = suggest("/effort", 5);
  assert.ok(matches.length > 0);
  assert.equal(matches[0].name, "effort");
  // The description reflects the redesigned effort ladder without reviving the
  // retired Team route.
  assert.match(matches[0].description, /deep-think debate/);
  assert.doesNotMatch(matches[0].description, /auto-dispatch|team/i);
});

test("suggest: /resume sorts the resume command to the top", () => {
  const matches = suggest("/resume", 5);
  assert.ok(matches.length > 0);
  assert.equal(matches[0].name, "resume");
});

test("exported argument schemas drive usage and completion", () => {
  const resume = resolve("/resume").cmd;
  const clear = resolve("/clear").cmd;
  const goal = resolve("/goal").cmd;
  assert.ok(resume && clear && goal);
  assert.equal(commandUsage(resume), "/resume [session]");
  assert.equal(commandAcceptsArguments(resume), true);
  assert.equal(commandAcceptsArguments(clear), false);
  assert.equal(goal.arguments?.min_args, 1);
});

test("client execution metadata distinguishes local, agent, info, and unavailable", () => {
  const clear = resolve("/clear").cmd;
  const review = resolve("/review").cmd;
  const contract = resolve("/contract").cmd;
  const mobile = resolve("/mobile").cmd;
  assert.ok(clear && review && contract && mobile);
  assert.equal(clientExecutionFor(clear, "tui").execution_state, "implemented_local");
  assert.equal(clientExecutionFor(clear, "terminal").execution_state, "info");
  assert.equal(clientExecutionFor(review, "tui").execution_state, "prompt");
  assert.equal(clientExecutionFor(contract, "tui").execution_state, "implemented_local");
  const tools = resolve("/tools").cmd;
  assert.ok(tools);
  assert.equal(clientExecutionFor(tools, "tui").execution_state, "implemented_local");
  assert.equal(clientExecutionFor(mobile, "tui").execution_state, "unsupported");
  assert.equal(commandBadges(review)[0], "agent");
  assert.equal(commandBadges(mobile)[0], "unavailable");
});

test("TUI handler registry metadata matches the current App handler switches", () => {
  const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
  const source = readFileSync(appPath, "utf8");
  const runLocalSlash = new Set([...source.matchAll(/name === "([^"]+)"/g)].map((match) => match[1]));
  const rawToken = new Set([...source.matchAll(/graphHead === "([^"]+)"/g)].map((match) => match[1]));
  assert.ok(rawToken.has("agi-workflow"), "missing raw /agi-workflow handler");
  const parity = clientRegistryParity("tui", { runLocalSlash, rawToken });
  for (const [handler, result] of Object.entries(parity)) {
    assert.deepEqual(result, { missing: [], extra: [] }, `${handler}: ${JSON.stringify(result)}`);
  }
});

test("semantic recovery stage transitions clear the previous authority's stream preview", () => {
  const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
  const source = readFileSync(appPath, "utf8");
  for (const event of ["semantic_fallback_start", "semantic_primary_resume_start"]) {
    const start = source.indexOf(`t === "${event}"`);
    assert.ok(start >= 0, `missing ${event} handler`);
    const handler = source.slice(start, start + 1200);
    assert.match(handler, /assistantBuf\.current = ""/);
    assert.match(handler, /streamPreview: ""/);
  }
});

test("product-default profiles name this Mac and public distribution without claiming runtime binding", () => {
  const defaults = productDefaults();
  assert.match(defaults.runtime_binding, /Declarative product metadata only/);
  const mac = productProfile("this-mac");
  const publicInstall = productProfile("public");
  assert.ok(mac && publicInstall);
  assert.equal(mac.model.value, "omlx");
  assert.equal(mac.authority.value, "full-authority");
  assert.equal(mac.authority.runtime_permission, "auto");
  assert.equal(mac.dispatch.value, "workflow");
  assert.equal(mac.image_generation.value, "Grok CLI");
  assert.equal(publicInstall.model.mode, "auto-detect");
  assert.equal(publicInstall.authority.mode, "configurable");
  assert.match(productProfileSummary("this-mac"), /model=omlx/);
  assert.equal(productProfile("missing"), null);
});

test("chooseSlashSubmission: typed /resume <name> wins over the menu highlight", () => {
  // The core regression guard: even if the slash-suggest menu is open and a
  // DIFFERENT command is highlighted, typing the full /resume <session> and
  // pressing Enter must submit the typed line so the session arg is preserved.
  const resumeMatches = suggest("/resume", 5);
  const modelMatches = suggest("/model", 5); // a different command's menu
  const submitted = chooseSlashSubmission("/resume tui-default", modelMatches, 0);
  assert.equal(submitted, "/resume tui-default");
  // And with the resume menu itself, the typed line still wins (not the highlight).
  assert.equal(chooseSlashSubmission("/resume prod", resumeMatches, 0), "/resume prod");
});

test("chooseSlashSubmission: unresolved typed line falls back to the highlighted match", () => {
  // If the typed text does not resolve (typo / no args yet), the highlighted
  // menu entry is submitted instead.
  const matches = suggest("/mo", 5); // "model", "mode", ...
  assert.ok(matches.length >= 2);
  const submitted = chooseSlashSubmission("/mo", matches, 1); // highlight on index 1
  assert.equal(submitted, matches[1].slash || "/" + matches[1].name);
});

test("chooseSlashSubmission: empty typed + non-empty matches submits the first match", () => {
  const matches = suggest("/effort", 3);
  const submitted = chooseSlashSubmission("", matches, 0);
  assert.equal(submitted, matches[0].slash || "/" + matches[0].name);
});

test("chooseSlashSubmission: nothing typed and no matches returns null (no submit)", () => {
  assert.equal(chooseSlashSubmission("", [], 0), null);
});

test("chooseSlashSubmission: out-of-range selectedIndex wraps to the first match", () => {
  const matches = suggest("/effort", 3);
  assert.ok(matches.length > 0);
  const submitted = chooseSlashSubmission("", matches, 999);
  assert.equal(submitted, matches[0].slash || "/" + matches[0].name);
});

test("chooseSlashSubmission: negative selectedIndex falls back to the first match instead of crashing", () => {
  // JS array indexing with a negative index returns undefined, not a
  // wrapped element — this is the same "stale index must not select the
  // wrong command" contract as the out-of-range case above, from the other
  // direction.
  const matches = suggest("/effort", 3);
  assert.ok(matches.length > 0);
  assert.equal(chooseSlashSubmission("", matches, -1), matches[0].slash || "/" + matches[0].name);
});

// --- completeSlashSelection: the pure decision behind Tab (App.tsx's
// applySlashSelection). Tested against the same catalog and the same
// stale-index contract as chooseSlashSubmission (Enter) so the two are
// provably coherent: Tab always writes a line that Enter, run immediately
// after, resolves to the exact same command. ---

test("completeSlashSelection: no match at all returns the input unchanged", () => {
  assert.equal(completeSlashSelection("/zzz", [], 0), "/zzz");
});

test("completeSlashSelection: out-of-range selectedIndex falls back to the first match, same as Enter", () => {
  const matches = suggest("/effort", 3);
  const completed = completeSlashSelection("/eff", matches, 999);
  const viaFirstMatch = completeSlashSelection("/eff", matches, 0);
  assert.equal(completed, viaFirstMatch);
});

test("completeSlashSelection: replaces the command token but keeps already-typed args", () => {
  const matches = suggest("/resume", 3);
  const completed = completeSlashSelection("/res tui-default", matches, 0);
  assert.equal(completed, "/resume tui-default");
});

test("completeSlashSelection: appends a trailing space for a command whose schema accepts an argument", () => {
  // /resume's schema accepts an optional session — no args typed yet, so Tab should
  // leave the cursor ready to type the session name, not glue it to the
  // command name.
  const matches = suggest("/resume", 3);
  const completed = completeSlashSelection("/res", matches, 0);
  assert.equal(completed, "/resume ");
});

test("completeSlashSelection: no trailing space for an argument-less command", () => {
  // /clear takes no argument and its hint carries none of [ ] < > | — Tab
  // should complete straight to "/clear" with no dangling space to delete.
  const matches = suggest("/clear", 3);
  assert.equal(completeSlashSelection("/cle", matches, 0), "/clear");
});

// --- rankSlashMatches: the pure relevance-tier scheme behind suggest()'s
// filter+sort (exact > prefix > substring; no fuzzy tier — see the doc
// comment on matchTier in slash.ts for why fuzzy was deliberately left out).
// Tested against small synthetic command lists rather than the generated
// catalog so these pin the TIER SCHEME itself, independent of whatever
// commands happen to exist today. ---

function cmd(name: string, aliases: string[] = []): SlashCommand {
  return {
    name,
    slash: "/" + name,
    description: name,
    category: "test",
    kind: "local",
    aliases,
  };
}

test("rankSlashMatches: exact match ranks above a longer prefix match", () => {
  const pool = [cmd("reviewer"), cmd("review")];
  const ranked = rankSlashMatches(pool, "review");
  assert.deepEqual(ranked.map((c) => c.name), ["review", "reviewer"]);
});

test("rankSlashMatches: prefix match ranks above a substring-only match", () => {
  const pool = [cmd("security-review"), cmd("review")];
  const ranked = rankSlashMatches(pool, "review");
  // "review" is an exact/prefix hit; "security-review" only contains
  // "review" mid-string (not a prefix) — it must still be included (this is
  // the exact regression: the old filter used `startsWith` only and
  // dropped substring-only commands from the menu entirely) but ranked
  // strictly after the prefix hit.
  assert.deepEqual(ranked.map((c) => c.name), ["review", "security-review"]);
});

test("rankSlashMatches: a command with no exact/prefix/substring hit is excluded", () => {
  const pool = [cmd("review"), cmd("model")];
  const ranked = rankSlashMatches(pool, "review");
  assert.deepEqual(ranked.map((c) => c.name), ["review"]);
});

test("rankSlashMatches: an alias-only prefix hit outranks a name-only substring hit", () => {
  // Regression: the old sort computed "starts with" against `c.name` alone
  // even though the filter step already matched via name-OR-alias. Neither
  // fixture's own NAME starts with "qu" ("launch-fast" starts with "la";
  // "mosquito" starts with "mo"), so under the old `a.name.startsWith(body)`
  // check both tied at "not a name-prefix" and the tie-break (name length,
  // then alphabetical) would have put "mosquito" (8 chars) ahead of
  // "launch-fast" (11 chars) — even though "launch-fast" is a genuine
  // *prefix* hit via its alias "quick" and "mosquito" is only a *substring*
  // hit via its name. Scoring against name-or-alias uniformly fixes that.
  const pool = [cmd("launch-fast", ["quick"]), cmd("mosquito")];
  const ranked = rankSlashMatches(pool, "qu");
  assert.deepEqual(ranked.map((c) => c.name), ["launch-fast", "mosquito"]);
});

test("rankSlashMatches: exact alias match outranks a name-prefix match on a different command", () => {
  const pool = [cmd("mode"), cmd("model", ["mo"])];
  const ranked = rankSlashMatches(pool, "mo");
  assert.deepEqual(ranked.map((c) => c.name), ["model", "mode"]);
});

test("suggest: substring-only matches are included below exact/prefix matches (typo/partial tolerance)", () => {
  // Real-catalog regression check for the same gap, using an actual pair
  // that exists in slash-commands.json today: /review and /security-review.
  const matches = suggest("/review", 0);
  const names = matches.map((c) => c.name);
  assert.equal(names[0], "review", "exact match must be ranked first");
  assert.ok(names.includes("security-review"), "substring-only match must still be surfaced, not hidden");
  assert.ok(names.indexOf("security-review") > names.indexOf("review"));
});

test("Tab then Enter is coherent: chooseSlashSubmission resolves exactly what completeSlashSelection just wrote", () => {
  const matches = suggest("/resume", 3);
  // No args yet: Tab appends a trailing space (an argument is expected);
  // Enter right after must still submit /resume, not silently swap in a
  // stale highlighted match or bail out because of the dangling space.
  const bare = completeSlashSelection("/res", matches, 0);
  assert.equal(bare, "/resume ");
  assert.equal(chooseSlashSubmission(bare, matches, 0), bare.trim());

  // Args already typed: Tab preserves them verbatim, and Enter submits the
  // identical string (no trailing space to trim this time).
  const withArgs = completeSlashSelection("/res tui-default", matches, 0);
  assert.equal(withArgs, "/resume tui-default");
  assert.equal(chooseSlashSubmission(withArgs, matches, 0), withArgs);
});
