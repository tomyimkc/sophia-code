export type AttachmentKind = "file" | "directory" | "image";

export interface AttachmentReference {
  id: string;
  kind: AttachmentKind;
  /** Platform-neutral spelling supplied by the user; never rewritten to `/`. */
  path: string;
  /** Original source slice including the `@file`/`@dir`/`@image` prefix. */
  raw: string;
  /** UTF-16 source offsets, matching JavaScript String.slice. */
  start: number;
  end: number;
  mediaType?: string;
}

export interface AttachmentParseIssue {
  start: number;
  end: number;
  code: "missing-path" | "unterminated-path" | "control-character";
  message: string;
}

export interface AttachmentParseResult {
  attachments: AttachmentReference[];
  issues: AttachmentParseIssue[];
}

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  avif: "image/avif",
  heic: "image/heic",
};

function canonicalKind(value: string): AttachmentKind {
  const lower = value.toLowerCase();
  if (lower === "dir" || lower === "directory") return "directory";
  if (lower === "image" || lower === "img") return "image";
  return "file";
}

export function imageMediaType(path: string): string | undefined {
  const withoutQuery = path.split(/[?#]/, 1)[0];
  const match = /\.([^.\\/]+)$/.exec(withoutQuery);
  return match ? IMAGE_MEDIA_TYPES[match[1].toLowerCase()] : undefined;
}

export function inferAttachmentKind(path: string): AttachmentKind {
  return imageMediaType(path) ? "image" : "file";
}

function stableAttachmentId(kind: AttachmentKind, path: string, start: number): string {
  let hash = 0x811c9dc5;
  const input = `${kind}\u0000${path}\u0000${start}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `attachment-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function readDelimited(
  input: string,
  start: number,
  open: string,
): { value: string; end: number; closed: boolean } {
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : open;
  let value = "";
  let index = start + 1;
  while (index < input.length) {
    const character = input[index];
    if (character === close) return { value, end: index + 1, closed: true };
    if (character === "\\" && index + 1 < input.length) {
      const next = input[index + 1];
      // Preserve Windows separators. Backslash is an escape only when it
      // protects the active delimiter.
      if (next === close) {
        value += next;
        index += 2;
        continue;
      }
    }
    value += character;
    index += 1;
  }
  return { value, end: input.length, closed: false };
}

function unwrapQuotedDelimitedValue(value: string): string {
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) return value;
  const parsed = readDelimited(value, 0, quote);
  return parsed.closed && parsed.end === value.length ? parsed.value : value;
}

function trimUnquotedTail(value: string): string {
  // Sentence punctuation is not normally part of a path. Keep `)`, `]`, and
  // `}` because they are valid filename characters unless used as delimiters.
  return value.replace(/[.,;!?]+$/u, "");
}

/**
 * Parse explicit attachment mentions without touching the filesystem.
 *
 * Supported portable forms:
 *   @file:README.md
 *   @dir("./src/lib")
 *   @image="C:\Users\me\screen shot.png"
 *   @file '../path with spaces.txt'
 *
 * Paths are preserved exactly so POSIX, Windows, UNC, and URI spellings can be
 * resolved later by the bridge that owns the workspace.
 */
export function parseAttachmentReferences(input: string): AttachmentParseResult {
  const attachments: AttachmentReference[] = [];
  const issues: AttachmentParseIssue[] = [];
  const mention = /@(file|dir|directory|image|img)\b/giu;
  let match: RegExpExecArray | null;

  while ((match = mention.exec(input)) !== null) {
    const start = match.index;
    const kind = canonicalKind(match[1]);
    let cursor = mention.lastIndex;
    while (cursor < input.length && /[ \t]/u.test(input[cursor])) cursor += 1;
    if (input[cursor] === ":" || input[cursor] === "=") {
      cursor += 1;
      while (cursor < input.length && /[ \t]/u.test(input[cursor])) cursor += 1;
    }

    let path = "";
    let end = cursor;
    const opener = input[cursor];
    if (opener === "\"" || opener === "'" || opener === "(" || opener === "[" || opener === "{") {
      const parsed = readDelimited(input, cursor, opener);
      path = opener === "(" || opener === "[" || opener === "{"
        ? unwrapQuotedDelimitedValue(parsed.value)
        : parsed.value;
      end = parsed.end;
      if (!parsed.closed) {
        issues.push({
          start,
          end,
          code: "unterminated-path",
          message: `Unterminated @${match[1]} attachment path.`,
        });
        mention.lastIndex = end;
        continue;
      }
    } else {
      while (end < input.length && !/\s/u.test(input[end])) end += 1;
      path = trimUnquotedTail(input.slice(cursor, end));
      end = cursor + path.length;
    }

    if (!path) {
      issues.push({
        start,
        end: Math.max(mention.lastIndex, end),
        code: "missing-path",
        message: `@${match[1]} requires a path.`,
      });
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/u.test(path)) {
      issues.push({
        start,
        end,
        code: "control-character",
        message: `@${match[1]} path contains a terminal control character.`,
      });
      mention.lastIndex = end;
      continue;
    }

    const attachment: AttachmentReference = {
      id: stableAttachmentId(kind, path, start),
      kind,
      path,
      raw: input.slice(start, end),
      start,
      end,
    };
    if (kind === "image") attachment.mediaType = imageMediaType(path);
    attachments.push(attachment);
    mention.lastIndex = end;
  }

  return { attachments, issues };
}

export function parseAttachments(input: string): AttachmentReference[] {
  return parseAttachmentReferences(input).attachments;
}

export function formatAttachmentReference(
  attachment: Pick<AttachmentReference, "kind" | "path">,
): string {
  const name = attachment.kind === "directory" ? "dir" : attachment.kind;
  const escaped = attachment.path.replace(/"/g, "\\\"");
  return `@${name}("${escaped}")`;
}
