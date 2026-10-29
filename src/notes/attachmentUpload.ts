/**
 * Adding a new image to an existing note: the pure pieces `push` composes.
 *
 * The record shapes are what Apple's own clients write, cross-checked
 * against natively-authored image notes in a real account (2026-10-29):
 *
 *  - a `Media` record holding the bytes (`Asset`), `FilenameEncrypted`,
 *    `Deleted: 0`, `MinimumSupportedNotesVersion: 0`, CloudKit parent = the
 *    note;
 *  - an `Attachment` record with `UTI`/`UTIEncrypted`, a VALIDATE `Media`
 *    reference and a VALIDATE `Note` reference, `FileSize`, `Width`/`Height`,
 *    `Orientation: 0`, creation/modification dates, parent = the note.
 *    Device-derived fields (previews, OCR, classification summaries,
 *    cropping quad) are deliberately absent: Apple clients regenerate them,
 *    and an image inserted this way rendered on Notes.app without them
 *    (apple-note-clone M3 acceptance, 2026-08-27);
 *  - in the note body, one U+FFFC per image on its own line, carried by a
 *    length-1 attribute run with `attachmentInfo` {id, UTI} and a seconds
 *    `timestamp`, inheriting the surrounding paragraph style.
 */

import { Buffer } from "node:buffer";
import { clone, create } from "@bufbuild/protobuf";
import { AttachmentInfoSchema, AttributeRunSchema } from "./gen/topotext_pb.js";
import type { NoteDocument } from "./noteDocument.js";

/** Notes' own per-attachment ceiling is far higher; this keeps an accidental
 * multi-gigabyte link from being read into memory and uploaded. */
export const MAX_NEW_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface DetectedImage {
  uti: string;
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * Identifies an image by its magic bytes (never by extension alone) and
 * reads its pixel dimensions where the header makes that cheap. Returns
 * undefined for anything that isn't a format Apple Notes stores as an
 * image attachment.
 */
export function detectImage(bytes: Uint8Array): DetectedImage | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { uti: "public.png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    return { uti: "public.jpeg", ...jpegDimensions(b) };
  }
  if (b.length >= 10 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) {
    return { uti: "com.compuserve.gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return { uti: "public.webp", ...webpDimensions(b) };
  }
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") {
    const brand = b.toString("latin1", 8, 12);
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return { uti: "public.heic" };
    }
  }
  if (b.length >= 4 && (b.toString("latin1", 0, 4) === "II*\0" || b.toString("latin1", 0, 4) === "MM\0*")) {
    return { uti: "public.tiff" };
  }
  return undefined;
}

function jpegDimensions(b: Buffer): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1] ?? 0;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return {};
}

function webpDimensions(b: Buffer): { width?: number; height?: number } {
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 " && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return {};
}

const encrypted = (text: string) => Buffer.from(text, "utf-8").toString("base64");

/** `Media` create fields; `asset` is the `singleFile` dictionary
 * `assets/upload` returned for this record's `Asset` field. */
export function buildMediaFields(fileName: string, asset: unknown): Record<string, { value: unknown }> {
  return {
    Asset: { value: asset },
    FilenameEncrypted: { value: encrypted(fileName) },
    Deleted: { value: 0 },
    MinimumSupportedNotesVersion: { value: 0 },
  };
}

export interface ImageAttachmentFieldsInput {
  noteRecordName: string;
  mediaRecordName: string;
  zoneName: string;
  uti: string;
  fileSize: number;
  width?: number | undefined;
  height?: number | undefined;
  nowMs: number;
}

export function buildImageAttachmentFields(input: ImageAttachmentFieldsInput): Record<string, { value: unknown }> {
  const ref = (recordName: string) => ({ value: { recordName, action: "VALIDATE", zoneID: { zoneName: input.zoneName } } });
  const fields: Record<string, { value: unknown }> = {
    UTI: { value: input.uti },
    UTIEncrypted: { value: encrypted(input.uti) },
    Media: ref(input.mediaRecordName),
    Note: ref(input.noteRecordName),
    Orientation: { value: 0 },
    Deleted: { value: 0 },
    FileSize: { value: input.fileSize },
    CreationDate: { value: input.nowMs },
    LastModificationDate: { value: input.nowMs },
    MinimumSupportedNotesVersion: { value: 0 },
  };
  if (input.width && input.height) {
    fields.Width = { value: input.width };
    fields.Height = { value: input.height };
  }
  return fields;
}

export interface NewEmbedPlacement {
  /** Index of the U+FFFC in `doc.text`. */
  index: number;
  attachmentIdentifier: string;
  typeUti: string;
}

/**
 * Gives each newly inserted placeholder its own length-1 attribute run
 * carrying the attachment reference. `applyTextEdit` leaves freshly typed
 * text merged into a neighbouring run; splitting keeps that run's paragraph
 * formatting on the placeholder, which is how Apple's own image runs look.
 */
export function attachNewEmbeds(doc: NoteDocument, placements: readonly NewEmbedPlacement[], timestampSeconds: number): void {
  for (const placement of placements) {
    if (doc.text[placement.index] !== "\ufffc") {
      throw new Error(`attachNewEmbeds: offset ${placement.index} is not a placeholder`);
    }
    const out = [];
    let offset = 0;
    let attached = false;
    for (const run of doc.attributeRuns) {
      const start = offset;
      const end = offset + run.length;
      offset = end;
      if (placement.index < start || placement.index >= end) {
        out.push(run);
        continue;
      }
      if (run.attachmentInfo !== undefined) {
        throw new Error(`attachNewEmbeds: offset ${placement.index} already belongs to an embed`);
      }
      const before = placement.index - start;
      const after = end - (placement.index + 1);
      if (before > 0) {
        const head = clone(AttributeRunSchema, run);
        head.length = before;
        out.push(head);
      }
      const embed = clone(AttributeRunSchema, run);
      embed.length = 1;
      embed.attachmentInfo = create(AttachmentInfoSchema, {
        attachmentIdentifier: placement.attachmentIdentifier,
        typeUTI: placement.typeUti,
      });
      embed.timestamp = BigInt(timestampSeconds);
      out.push(embed);
      if (after > 0) {
        const tail = clone(AttributeRunSchema, run);
        tail.length = after;
        out.push(tail);
      }
      attached = true;
    }
    if (!attached) {
      throw new Error(`attachNewEmbeds: no attribute run covers offset ${placement.index}`);
    }
    doc.attributeRuns = out;
  }
}
