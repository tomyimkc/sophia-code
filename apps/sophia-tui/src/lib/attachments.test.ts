import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAttachmentReference,
  imageMediaType,
  inferAttachmentKind,
  parseAttachmentReferences,
  parseAttachments,
} from "./attachments.js";

test("parses explicit file, directory, and image references with source ranges", () => {
  const input = "Review @file:README.md and @dir(./src/lib) plus @image:\"screen shot.png\".";
  const result = parseAttachmentReferences(input);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(
    result.attachments.map(({ kind, path, mediaType }) => ({ kind, path, mediaType })),
    [
      { kind: "file", path: "README.md", mediaType: undefined },
      { kind: "directory", path: "./src/lib", mediaType: undefined },
      { kind: "image", path: "screen shot.png", mediaType: "image/png" },
    ],
  );
  for (const attachment of result.attachments) {
    assert.equal(input.slice(attachment.start, attachment.end), attachment.raw);
  }
});

test("preserves Windows drive, UNC, POSIX, and URI spellings", () => {
  const input = String.raw`@file("C:\Program Files\Sophia\AGENTS.md") @dir("\\server\share\repo") @image:https://example.test/a.png`;
  assert.deepEqual(parseAttachments(input).map((attachment) => attachment.path), [
    String.raw`C:\Program Files\Sophia\AGENTS.md`,
    String.raw`\\server\share\repo`,
    "https://example.test/a.png",
  ]);
});

test("quoted paths can contain spaces and escaped delimiters", () => {
  const result = parseAttachments(String.raw`@file('docs/owner\'s notes.md')`);
  assert.equal(result[0]?.path, "docs/owner's notes.md");
});

test("malformed references report issues instead of inventing an attachment", () => {
  const missing = parseAttachmentReferences("open @file");
  assert.equal(missing.attachments.length, 0);
  assert.equal(missing.issues[0]?.code, "missing-path");

  const unterminated = parseAttachmentReferences("open @image(\"screen.png");
  assert.equal(unterminated.attachments.length, 0);
  assert.equal(unterminated.issues[0]?.code, "unterminated-path");

  const control = parseAttachmentReferences("open @file(\"bad\u0007name\")");
  assert.equal(control.attachments.length, 0);
  assert.equal(control.issues[0]?.code, "control-character");
});

test("image type inference is extension-based and case-insensitive", () => {
  assert.equal(imageMediaType("photo.JPEG?raw=1"), "image/jpeg");
  assert.equal(imageMediaType("diagram.svg#icon"), "image/svg+xml");
  assert.equal(imageMediaType("README.md"), undefined);
  assert.equal(inferAttachmentKind("capture.webp"), "image");
  assert.equal(inferAttachmentKind("archive.tar"), "file");
});

test("canonical formatting quotes cross-platform paths deterministically", () => {
  assert.equal(
    formatAttachmentReference({ kind: "directory", path: String.raw`C:\repo dir` }),
    String.raw`@dir("C:\repo dir")`,
  );
  assert.equal(
    formatAttachmentReference({ kind: "image", path: "a\"b.png" }),
    String.raw`@image("a\"b.png")`,
  );
});
