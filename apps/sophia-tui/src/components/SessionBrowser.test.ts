import test from "node:test";
import assert from "node:assert/strict";
import * as sessionBrowserModule from "./SessionBrowser.js";
import { sessionRowTitle, sessionRowMeta, statusHeaderLines } from "./SessionBrowser.js";
import type { SessionListItem } from "../lib/sessionStore.js";

function row(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "sess-20260729-184030",
    name: "sess-20260729-184030",
    path: "/x/sess-20260729-184030.json",
    turns: 177,
    updatedAt: 0,
    lastPreview: "last thing said",
    description: "find the kimi 3 technical report",
    recency: "2h ago",
    ...overrides,
  };
}

test("sessionRowTitle prefers the topic (description), then preview, then id", () => {
  assert.equal(sessionRowTitle(row()), "find the kimi 3 technical report");
  assert.equal(sessionRowTitle(row({ description: "" })), "last thing said");
  assert.equal(sessionRowTitle(row({ description: "", lastPreview: "" })), "sess-20260729-184030");
});

test("sessionRowTitle collapses wrapped whitespace and is never blank", () => {
  assert.equal(
    sessionRowTitle(row({ description: "fix\nthe   resume\tbug" })),
    "fix the resume bug",
  );
  // All-blank fields still yield the id, never an empty row label.
  assert.equal(sessionRowTitle(row({ description: "   ", lastPreview: "  " })), "sess-20260729-184030");
  assert.equal(
    sessionRowTitle(row({ description: "safe\u001b]52;c;c2VjcmV0\u0007 title" })),
    "safe title",
  );
  assert.equal(
    sessionRowTitle(row({ description: "safe\u009d52;c;c2VjcmV0\u009c title" })),
    "safe title",
  );
});

test("sessionRowMeta pluralizes turns and appends recency", () => {
  assert.equal(sessionRowMeta(row({ turns: 177, recency: "2h ago" })), "177 turns · 2h ago");
  assert.equal(sessionRowMeta(row({ turns: 1, recency: "just now" })), "1 turn · just now");
  assert.equal(sessionRowMeta(row({ turns: 0, recency: "3d ago" })), "0 turns · 3d ago");
});

test("session search evidence names the matching record and occurrence count", () => {
  const format = (sessionBrowserModule as unknown as {
    sessionRowMatch?: (value: SessionListItem) => string;
  }).sessionRowMatch;
  assert.equal(typeof format, "function", "SessionBrowser must expose its search evidence formatter");
  assert.equal(format!(row()), "");
  assert.equal(
    format!(row({
      match: {
        field: "assistant",
        preview: "The \u001b[31mquantum\u001b[0m bridge failure came from stale event ordering.",
        occurrences: 2,
        score: 35,
      },
    })),
    "assistant · The quantum bridge failure came from stale event ordering. · 2 hits",
  );
  assert.equal(
    format!(row({
      match: {
        field: "assistant",
        preview: "The \u009b31mquantum\u009b0m bridge failure came from stale event ordering.",
        occurrences: 1,
        score: 35,
      },
    })),
    "assistant · The quantum bridge failure came from stale event ordering.",
  );
});

test("session browser labels filtered results and their empty state truthfully", () => {
  const describe = (sessionBrowserModule as unknown as {
    sessionBrowserCopy?: (count: number, query?: string, totalMatches?: number) => {
      title: string;
      detail: string;
      empty: string;
    };
  }).sessionBrowserCopy;
  assert.equal(typeof describe, "function", "SessionBrowser must expose its mode copy");
  assert.deepEqual(describe!(2), {
    title: "Resume a session",
    detail: "2 saved · ↑↓ select · Enter resume · Esc cancel",
    empty: "No saved sessions yet — run something and it will show up here.",
  });
  assert.deepEqual(describe!(1, "  quantum   bridge  "), {
    title: "Search sessions",
    detail: "1 match for “quantum bridge” · ↑↓ select · Enter resume · Esc cancel",
    empty: "No saved sessions match “quantum bridge”.",
  });
  assert.deepEqual(describe!(50, "quantum bridge", 72), {
    title: "Search sessions",
    detail: "Top 50 of 72 matches for “quantum bridge” · ↑↓ select · Enter resume · Esc cancel",
    empty: "No saved sessions match “quantum bridge”.",
  });
  assert.deepEqual(describe!(0, "safe\u001b]52;c;c2VjcmV0\u0007 query"), {
    title: "Search sessions",
    detail: "0 matches for “safe query” · ↑↓ select · Enter resume · Esc cancel",
    empty: "No saved sessions match “safe query”.",
  });
  assert.deepEqual(describe!(0, "safe\u009d52;c;c2VjcmV0\u009c query"), {
    title: "Search sessions",
    detail: "0 matches for “safe query” · ↑↓ select · Enter resume · Esc cancel",
    empty: "No saved sessions match “safe query”.",
  });
});

test("session browser dimensions stay inside a narrow terminal", () => {
  const innerWidth = (sessionBrowserModule as unknown as {
    sessionBrowserInnerWidth?: (width: number) => number;
  }).sessionBrowserInnerWidth;
  assert.equal(typeof innerWidth, "function", "SessionBrowser must expose its width clamp");
  assert.equal(innerWidth!(120), 118);
  assert.equal(innerWidth!(8), 6);
  assert.equal(innerWidth!(1), 1);

  const compact = (sessionBrowserModule as unknown as {
    sessionBrowserCompactMode?: (height: number, headerLines?: number) => boolean;
  }).sessionBrowserCompactMode;
  assert.equal(typeof compact, "function", "SessionBrowser must expose its compact-height rule");
  assert.equal(compact!(3), true);
  assert.equal(compact!(5), true);
  assert.equal(compact!(8), true);
  assert.equal(compact!(9), false);
  assert.equal(compact!(12, 3), true, "status header rows also consume the pane budget");

  const showMeta = (sessionBrowserModule as unknown as {
    sessionBrowserShowMeta?: (width: number) => boolean;
  }).sessionBrowserShowMeta;
  assert.equal(typeof showMeta, "function", "SessionBrowser must expose its metadata width rule");
  assert.equal(showMeta!(32), false);
  assert.equal(showMeta!(47), false);
  assert.equal(showMeta!(48), true);
});

test("statusHeaderLines lays out the run status the /status header draws", () => {
  // /status draws these dim lines above the session list: harness state on the
  // first, permission + session on the second, working directory on the third.
  const lines = statusHeaderLines({
    model: "020s-terra",
    effort: "max",
    mode: "team",
    permission: "auto",
    session: "sess-20260730-122643",
    cwd: "/repo",
  });
  assert.deepEqual(lines, [
    "model=020s-terra  effort=max  mode=team",
    "permission=auto  session=sess-20260730-122643",
    "cwd=/repo",
  ]);
});
