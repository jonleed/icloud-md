/**
 * Pure logic behind `push`'s embed-bearing note path (Step 1 of the
 * formatting plan, 2026-07-17): matches a note's embed slots (see
 * `decodeNoteEmbedSlots`) against their local representations - inline embed
 * markers and rendered markdown table blocks - and reconstructs the "true"
 * body text (U+FFFC placeholders) that `TextDataEncrypted` actually stores.
 *
 * The policy: every marker must survive **verbatim**, in document order.
 * Edits around markers are fine; a deleted, edited, duplicated, or
 * reordered marker refuses the push with a reason naming what went wrong.
 * The network/fs orchestration lives in `src/commands/push.ts`.
 */

import path from "node:path";
import { findMarkdownTableBlocks, type MarkdownTableBlock } from "./markdownTable.js";
import {
  formatAttachmentMarkdown,
  hasAttachmentReference,
  isTableUti,
  OBJECT_REPLACEMENT_CHARACTER,
  type AttachmentReference,
  type EmbedSlot,
} from "./noteAttachments.js";
import { formatEmbedMarker, parseEmbedMarkers } from "./unknownContent.js";

/** One table slot matched to its local markdown block, in document order -
 * what `push`'s table-attachment update loop consumes. */
export interface MatchedTableBlock {
  ref: AttachmentReference;
  block: MarkdownTableBlock;
}

export type EmbedRepresentationPlan =
  | {
      ok: true;
      /** `localText` with every marker and table block replaced by U+FFFC -
       * the desired body text, comparable against the remote note's own. */
      reconstructedBodyText: string;
      /** Table slots in document order (may be empty). */
      tables: MatchedTableBlock[];
      /** Links to files that aren't attachments yet, in document order;
       * each `ordinal` is its placeholder's position among all of
       * `reconstructedBodyText`'s placeholders. */
      newAttachments: NewAttachmentLink[];
    }
  | { ok: false; reason: string };

/** A local `attachments/...` link with no attachment record behind it yet -
 * a file for `push` to upload and embed. */
export interface NewAttachmentLink {
  ordinal: number;
  /** The link exactly as written, e.g. `![x](attachments/x%201.png)`. */
  linkText: string;
  /** Its target, URI-decoded and relative to the note's own directory. */
  href: string;
  /** `![...](...)` rather than `[...](...)`. */
  isImage: boolean;
  /** Set for an Obsidian-style embed - `![[file]]`, or a markdown link to a
   * file outside `attachments/` - resolved against the vault's files: the
   * vault-relative path of the file it names. `href` is unused then. */
  vaultPath?: string | undefined;
}

/** The vault's non-note files, for resolving Obsidian-style embeds. */
export interface VaultFiles {
  /** The note's directory, vault-relative and POSIX ("" at the root). */
  noteDir: string;
  /** Every non-`.md` file in the vault, vault-relative POSIX paths. */
  files: ReadonlySet<string>;
}

const ATTACHMENT_LINK_PATTERN = /(!?)\[[^\]\n]*\]\((attachments\/[^)\n]+)\)/g;
const WIKI_EMBED_PATTERN = /!\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK_PATTERN = /(!?)\[[^\]\n]*\]\(([^)\n]+)\)/g;

/**
 * Resolves an Obsidian link target to a vault file the way Obsidian does:
 * a path is tried relative to the note, then from the vault root; a bare
 * name is looked for beside the note, in its `attachments/`, and then
 * anywhere in the vault - where it must be unique. `undefined` when nothing
 * matches (the link stays literal text); "ambiguous" when a bare name
 * matches several files.
 */
export function resolveVaultFile(target: string, vault: VaultFiles): string | "ambiguous" | undefined {
  const clean = target.replace(/^\.\//, "");
  const join = (dir: string, name: string) => path.posix.normalize(dir === "" ? name : `${dir}/${name}`);
  if (clean.includes("/")) {
    for (const candidate of [join(vault.noteDir, clean), path.posix.normalize(clean.replace(/^\/+/, ""))]) {
      if (!candidate.startsWith("../") && vault.files.has(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
  for (const candidate of [join(vault.noteDir, clean), join(vault.noteDir, `attachments/${clean}`)]) {
    if (vault.files.has(candidate)) {
      return candidate;
    }
  }
  const matches = [...vault.files].filter((file) => path.posix.basename(file) === clean);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? "ambiguous" : undefined;
}

interface VaultEmbed {
  start: number;
  end: number;
  linkText: string;
  isImage: boolean;
  resolved: string | "ambiguous";
}

/** Obsidian-style embeds in `text` that name a real vault file. Links that
 * resolve to nothing - URLs, other notes, missing files - aren't returned:
 * they're ordinary text. */
function findVaultEmbeds(text: string, vault: VaultFiles): VaultEmbed[] {
  const found: VaultEmbed[] = [];
  for (const match of text.matchAll(WIKI_EMBED_PATTERN)) {
    // `![[name|alias]]`, `![[name#heading]]`: the file is the part before.
    const target = (match[1] ?? "").split(/[|#]/)[0]?.trim() ?? "";
    const resolved = target === "" ? undefined : resolveVaultFile(target, vault);
    if (resolved !== undefined) {
      found.push({ start: match.index, end: match.index + match[0].length, linkText: match[0], isImage: true, resolved });
    }
  }
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    let href = (match[2] ?? "").trim();
    // `[x](<path with spaces>)` and `[x](path "title")`.
    href = href.startsWith("<") ? href.slice(1, href.indexOf(">") === -1 ? undefined : href.indexOf(">")) : (href.split(/\s+"/)[0] ?? "");
    if (href.startsWith("attachments/") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      continue;
    }
    const resolved = resolveVaultFile(decoded, vault);
    if (resolved !== undefined) {
      found.push({ start: match.index, end: match.index + match[0].length, linkText: match[0], isImage: match[1] === "!", resolved });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Whether `text` has an Obsidian-style embed naming a real vault file. */
export function hasVaultEmbed(text: string, vault: VaultFiles | undefined): boolean {
  return vault !== undefined && findVaultEmbeds(text.replace(/\r\n?|\n/g, "\n"), vault).length > 0;
}

interface LocalRepresentation {
  /** Character range [start, end) in `localText` this representation spans. */
  start: number;
  end: number;
  table?: MatchedTableBlock | undefined;
}

/**
 * Locates each embed slot's local representation and verifies the
 * marker-survival policy. A slot is marker-represented when it's `unknown`
 * (pull always wrote a marker) or when its attachment id appears among the
 * local markers (pull couldn't render it - an undecodable table, an
 * unresolvable file chain, an unsupported kind). An identified table slot
 * without a marker expects a markdown table block; an id found in
 * `trackedFileAttachmentIds` (attachment records that resolved to downloaded
 * files at pull time, from `state.attachments`) keeps the existing
 * file-attachment refusal - there's no file write path yet.
 */
export function planEmbedRepresentations(
  localText: string,
  slots: readonly EmbedSlot[],
  trackedFileAttachmentIds: ReadonlySet<string>,
  /** Attachment recordName -> the note-relative link path `pull` rendered
   * for that downloaded file (`linkPath` in `attachmentSync.ts`). A tracked
   * file attachment found here is matched like a marker: its rendered
   * markdown (`formatAttachmentMarkdown`) must survive verbatim and in
   * document order, and maps straight back to its original placeholder (its
   * `attachmentInfo` run is never rewritten). Omitted, or missing an id,
   * keeps the read-only refusal for that attachment. */
  fileAttachmentLinkPaths: ReadonlyMap<string, string> = new Map(),
  /** The vault's files, to recognise Obsidian-style embeds as new
   * attachments. Omitted, only `attachments/...` links are. */
  vaultFiles?: VaultFiles,
): EmbedRepresentationPlan {
  // Marker and table parsers use LF line positions. Normalize once before
  // discovery and splicing so every offset refers to the same string that
  // the Markdown parser and push reconciler will consume.
  localText = localText.replace(/\r\n?|\n/g, "\n");
  const markers = parseEmbedMarkers(localText);
  const markerIds = new Set(
    markers.map((marker) => marker.attachmentIdentifier).filter((id): id is string => id !== undefined),
  );
  const tableBlocks = findMarkdownTableBlocks(localText);
  const lineStartOffsets = computeLineStartOffsets(localText);

  const representations: LocalRepresentation[] = [];
  let markerCursor = 0;
  let tableCursor = 0;

  for (const slot of slots) {
    const markerContent =
      slot.kind === "unknown" ? { typeUti: slot.typeUti } : markerIds.has(slot.ref.attachmentIdentifier) ? slot.ref : undefined;

    if (markerContent === undefined && slot.kind === "attachment") {
      if (isTableUti(slot.ref.typeUti)) {
        const block = tableBlocks[tableCursor];
        if (!block) {
          return {
            ok: false,
            reason: `can't tell which table(s) changed (found ${tableBlocks.length} table-shaped block(s) locally, expected more)`,
          };
        }
        tableCursor += 1;
        representations.push({
          start: lineStartOffsets[block.startLine] ?? localText.length,
          // The block's last line ends either just before the next line's
          // start or at the end of the text (no trailing newline).
          end: block.endLine < lineStartOffsets.length ? (lineStartOffsets[block.endLine] ?? localText.length + 1) - 1 : localText.length,
          table: { ref: slot.ref, block },
        });
        continue;
      }
      const linkPath = fileAttachmentLinkPaths.get(slot.ref.attachmentIdentifier);
      if (linkPath !== undefined) {
        const expectedLink = formatAttachmentMarkdown(slot.ref, linkPath);
        // Either form stands for the attachment - an image embed
        // `![name](href)` or a plain link `[name](href)` - so a file rendered
        // before its type was known to be an image (or the reverse) still
        // matches, and a typed "!" never survives as a stray character.
        const plainLink = expectedLink.startsWith("!") ? expectedLink.slice(1) : expectedLink;
        // Search from just past the previous representation so a repeated
        // link (the same file embedded twice) binds in document order.
        const searchFrom = representations.length > 0 ? (representations[representations.length - 1]?.end ?? 0) : 0;
        const found = localText.indexOf(plainLink, searchFrom);
        const start = found > searchFrom && localText[found - 1] === "!" ? found - 1 : found;
        if (found !== -1) {
          representations.push({ start, end: found + plainLink.length });
          continue;
        }
        return {
          ok: false,
          reason:
            `the attachment link ${expectedLink} is missing, edited, or out of order - ` +
            "attachment links must be left exactly as this tool wrote them",
        };
      }
      if (trackedFileAttachmentIds.has(slot.ref.attachmentIdentifier)) {
        return {
          ok: false,
          reason: "this note has a file attachment - it can't be edited through this tool and stays read-only",
        };
      }
      return {
        ok: false,
        reason:
          `the embed marker for "${slot.ref.typeUti}" (${slot.ref.attachmentIdentifier}) is missing - ` +
          "markers must be left exactly as this tool wrote them",
      };
    }

    // Marker-represented. The next unconsumed marker must be exactly what
    // pull would have written for this slot - anything else is an edited,
    // reordered, or missing marker.
    const expected = formatEmbedMarker(markerContent ?? {});
    const marker = markers[markerCursor];
    if (!marker) {
      return {
        ok: false,
        reason: `an embed marker is missing (expected ${expected}) - markers must be left exactly as this tool wrote them`,
      };
    }
    markerCursor += 1;
    if (marker.text !== expected) {
      return {
        ok: false,
        reason:
          `an embed marker was edited or is out of order (found ${marker.text}, expected ${expected}) - ` +
          "markers must be left exactly as this tool wrote them",
      };
    }
    representations.push({ start: marker.start, end: marker.end });
  }

  const extraMarker = markers[markerCursor];
  if (extraMarker) {
    return {
      ok: false,
      reason: `found an embed marker with nothing behind it (${extraMarker.text}) - this tool can't create embeds; remove it`,
    };
  }
  if (tableCursor < tableBlocks.length) {
    return {
      ok: false,
      reason:
        `can't tell which table(s) changed (found ${tableBlocks.length} table-shaped block(s) locally, ` +
        `expected ${tableCursor})`,
    };
  }

  // Document-order sanity: each representation must start after the previous
  // one ends (also catches a marker and a table block overlapping).
  let previousEnd = -1;
  for (const representation of representations) {
    if (representation.start < previousEnd) {
      return {
        ok: false,
        reason: "embed markers and tables appear out of document order - markers must stay where this tool wrote them",
      };
    }
    previousEnd = representation.end;
  }

  // Every remaining "attachments/..." link is a new file to upload: it is
  // not one pull wrote for an existing embed (those were all consumed
  // above). Apple's clients always give an image its own paragraph, so a new
  // link must stand alone on its line - anything else is refused rather than
  // silently pushed as literal text.
  const newAttachments: NewAttachmentLink[] = [];
  const combined: { start: number; end: number; newLink?: NewAttachmentLink }[] = [...representations];
  for (const match of localText.matchAll(ATTACHMENT_LINK_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (representations.some((r) => start < r.end && end > r.start)) {
      continue;
    }
    const lineStart = localText.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = localText.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? localText.length : lineEndIndex;
    if (localText.slice(lineStart, start).trim() !== "" || localText.slice(end, lineEnd).trim() !== "") {
      return {
        ok: false,
        reason: `the new attachment link ${match[0]} must be on a line of its own`,
      };
    }
    let href: string;
    try {
      href = decodeURIComponent(match[2] ?? "");
    } catch {
      return { ok: false, reason: `the attachment link ${match[0]} has a malformed path` };
    }
    const link: NewAttachmentLink = { ordinal: -1, linkText: match[0], href, isImage: match[1] === "!" };
    combined.push({ start, end, newLink: link });
  }
  for (const embed of vaultFiles ? findVaultEmbeds(localText, vaultFiles) : []) {
    if (combined.some((r) => embed.start < r.end && embed.end > r.start)) {
      continue;
    }
    const lineStart = localText.lastIndexOf("\n", embed.start - 1) + 1;
    const lineEndIndex = localText.indexOf("\n", embed.end);
    const lineEnd = lineEndIndex === -1 ? localText.length : lineEndIndex;
    if (localText.slice(lineStart, embed.start).trim() !== "" || localText.slice(embed.end, lineEnd).trim() !== "") {
      return { ok: false, reason: `the embedded file ${embed.linkText} must be on a line of its own` };
    }
    if (embed.resolved === "ambiguous") {
      return { ok: false, reason: `${embed.linkText} matches more than one file in the vault - link it by its path` };
    }
    const link: NewAttachmentLink = {
      ordinal: -1,
      linkText: embed.linkText,
      href: "",
      isImage: embed.isImage,
      vaultPath: embed.resolved,
    };
    combined.push({ start: embed.start, end: embed.end, newLink: link });
  }
  combined.sort((a, b) => a.start - b.start);
  combined.forEach((representation, ordinal) => {
    if (representation.newLink) {
      representation.newLink.ordinal = ordinal;
      newAttachments.push(representation.newLink);
    }
  });

  // Splice each representation back down to its placeholder, right to left
  // so earlier offsets stay valid.
  let reconstructed = localText;
  for (const representation of [...combined].reverse()) {
    reconstructed =
      reconstructed.slice(0, representation.start) + OBJECT_REPLACEMENT_CHARACTER + reconstructed.slice(representation.end);
  }

  if (hasAttachmentReference(reconstructed)) {
    return {
      ok: false,
      reason: 'contains an "attachments/..." link this tool couldn\'t place - remove it',
    };
  }

  return {
    ok: true,
    reconstructedBodyText: reconstructed,
    tables: representations.flatMap((representation) => (representation.table ? [representation.table] : [])),
    newAttachments,
  };
}

function computeLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}
