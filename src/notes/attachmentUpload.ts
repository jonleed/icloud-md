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
    // What Apple writes for WebP (seen on a real account).
    return { uti: "org.webmproject.webp", ...webpDimensions(b) };
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

export interface DetectedFile {
  uti: string;
  isImage: boolean;
  width?: number | undefined;
  height?: number | undefined;
  /** Playing time, for audio and video Notes shows a duration for. */
  durationSeconds?: number | undefined;
}

/**
 * Identifies a file to attach. Images, PDFs and common audio/video are
 * recognised by their bytes, and a file whose extension claims one of those
 * types but whose bytes don't match is refused (returns `undefined`), so a
 * misnamed file never reaches a device as something it can't open. Anything
 * else is attached by its extension - as a generic file when that's unknown.
 */
export function detectFile(bytes: Uint8Array, fileName: string): DetectedFile | undefined {
  const extension = fileName.includes(".") ? (fileName.split(".").pop() ?? "").toLowerCase() : "";
  const image = detectImage(bytes);
  if (image) {
    return { ...image, isImage: true };
  }
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.toString("latin1", 0, 5) === "%PDF-") {
    return { uti: "com.adobe.pdf", isImage: false };
  }
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE") {
    return { uti: "com.microsoft.waveform-audio", isImage: false, durationSeconds: wavDuration(b) };
  }
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") {
    const brand = b.toString("latin1", 8, 12);
    const uti = brand === "M4A " || brand === "M4B " ? "com.apple.m4a-audio" : brand === "qt  " ? "com.apple.quicktime-movie" : "public.mpeg-4";
    return { uti, isImage: false, durationSeconds: mp4Duration(b) };
  }
  const mp3 = mp3Duration(b);
  if (mp3 !== undefined) {
    return { uti: "public.mp3", isImage: false, durationSeconds: mp3 };
  }
  if (BYTE_CHECKED_EXTENSIONS.has(extension)) {
    return undefined;
  }
  return { uti: EXTENSION_UTIS[extension] ?? "public.data", isImage: false };
}

/** Extensions whose type `detectFile` checks by content. */
const BYTE_CHECKED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff",
  "pdf", "wav", "m4a", "m4b", "mp4", "m4v", "mov", "mp3",
]);

const EXTENSION_UTIS: Record<string, string> = {
  txt: "public.plain-text",
  md: "net.daringfireball.markdown",
  csv: "public.comma-separated-values-text",
  json: "public.json",
  html: "public.html",
  rtf: "public.rtf",
  zip: "public.zip-archive",
  doc: "com.microsoft.word.doc",
  docx: "org.openxmlformats.wordprocessingml.document",
  xls: "com.microsoft.excel.xls",
  xlsx: "org.openxmlformats.spreadsheetml.sheet",
  ppt: "com.microsoft.powerpoint.ppt",
  pptx: "org.openxmlformats.presentationml.presentation",
  pages: "com.apple.iwork.pages.sffpages",
  numbers: "com.apple.iwork.numbers.sffnumbers",
  key: "com.apple.iwork.keynote.sffkey",
  aac: "public.aac-audio",
  flac: "org.xiph.flac",
  ogg: "org.xiph.ogg",
};

function wavDuration(b: Buffer): number | undefined {
  let byteRate: number | undefined;
  let offset = 12;
  while (offset + 8 <= b.length) {
    const id = b.toString("latin1", offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 20 <= b.length) {
      byteRate = b.readUInt32LE(offset + 16);
    } else if (id === "data" && byteRate) {
      return Math.min(size, b.length - offset - 8) / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** The movie header's duration (moov/mvhd), in seconds. */
function mp4Duration(b: Buffer): number | undefined {
  const findBox = (start: number, end: number, type: string): [number, number] | undefined => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = b.readUInt32BE(offset);
      let header = 8;
      if (size === 1 && offset + 16 <= end) {
        size = Number(b.readBigUInt64BE(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header) {
        return undefined;
      }
      if (b.toString("latin1", offset + 4, offset + 8) === type) {
        return [offset + header, Math.min(offset + size, end)];
      }
      offset += size;
    }
    return undefined;
  };
  const moov = findBox(0, b.length, "moov");
  const mvhd = moov && findBox(moov[0], moov[1], "mvhd");
  if (!mvhd) {
    return undefined;
  }
  const [at] = mvhd;
  const version = b[at];
  if (version === 1 && at + 32 <= b.length) {
    const timescale = b.readUInt32BE(at + 20);
    return timescale ? Number(b.readBigUInt64BE(at + 24)) / timescale : undefined;
  }
  if (at + 20 <= b.length) {
    const timescale = b.readUInt32BE(at + 12);
    return timescale ? b.readUInt32BE(at + 16) / timescale : undefined;
  }
  return undefined;
}

const MP3_BITRATES: Record<string, number[]> = {
  // [version-class][layer] -> kbit/s by index (0 = free, 15 = bad)
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Mp3Frame {
  length: number;
  samples: number;
  sampleRate: number;
}

function mp3Frame(b: Buffer, at: number): Mp3Frame | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || ((b[at + 1] ?? 0) & 0xe0) !== 0xe0) {
    return undefined;
  }
  const versionBits = ((b[at + 1] ?? 0) >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = ((b[at + 1] ?? 0) >> 1) & 3; // 3 = I, 2 = II, 1 = III
  const bitrateIndex = ((b[at + 2] ?? 0) >> 4) & 15;
  const rateIndex = ((b[at + 2] ?? 0) >> 2) & 3;
  const padding = ((b[at + 2] ?? 0) >> 1) & 1;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
    return undefined;
  }
  const layer = 4 - layerBits;
  const bitrate = (MP3_BITRATES[`${versionBits === 3 ? 1 : 2}-${layer}`]?.[bitrateIndex] ?? 0) * 1000;
  const sampleRate = MP3_SAMPLE_RATES[versionBits]?.[rateIndex] ?? 0;
  if (!bitrate || !sampleRate) {
    return undefined;
  }
  if (layer === 1) {
    return { length: (Math.floor((12 * bitrate) / sampleRate) + padding) * 4, samples: 384, sampleRate };
  }
  const mpeg1 = versionBits === 3;
  const samples = layer === 3 && !mpeg1 ? 576 : 1152;
  return { length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding, samples, sampleRate };
}

/**
 * An MPEG audio file's playing time, from counting its frames (exact for
 * both constant and variable bitrate). `undefined` unless the data opens
 * (after any ID3v2 tag) with several consecutive valid frames, which is also
 * what identifies the file as MP3 at all.
 */
function mp3Duration(b: Buffer): number | undefined {
  let at = 0;
  if (b.toString("latin1", 0, 3) === "ID3" && b.length >= 10) {
    const size = (((b[6] ?? 0) & 0x7f) << 21) | (((b[7] ?? 0) & 0x7f) << 14) | (((b[8] ?? 0) & 0x7f) << 7) | ((b[9] ?? 0) & 0x7f);
    at = 10 + size + (((b[5] ?? 0) & 0x10) !== 0 ? 10 : 0);
  }
  let samples = 0;
  let frames = 0;
  let sampleRate = 0;
  for (;;) {
    const frame = mp3Frame(b, at);
    if (!frame || at + frame.length > b.length) {
      break;
    }
    // A Xing/Info/VBRI frame describes the stream rather than carrying audio.
    const body = b.toString("latin1", at + 4, Math.min(at + 40, b.length));
    const isInfoFrame = frames === 0 && (body.includes("Xing") || body.includes("Info") || body.includes("VBRI"));
    if (!isInfoFrame) {
      samples += frame.samples;
    }
    sampleRate = frame.sampleRate;
    frames += 1;
    at += frame.length;
  }
  return frames >= 3 && sampleRate ? samples / sampleRate : undefined;
}

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

export interface AttachmentFieldsInput extends ImageAttachmentFieldsInput {
  /** The file's name, shown on a non-image attachment's card. */
  fileName?: string | undefined;
  isImage?: boolean | undefined;
  durationSeconds?: number | undefined;
}

/**
 * The Attachment record for any new file, in the shape Apple's own clients
 * write: images carry their pixel size, other files their name (Apple's
 * captured MP3 attachment has a `TitleEncrypted`; its images don't), audio
 * and video their duration. FileSize is typed INT64 as Apple writes it -
 * untyped, CloudKit stores a number as a DOUBLE.
 */
export function buildAttachmentFields(input: AttachmentFieldsInput): Record<string, { value: unknown; type?: string }> {
  const fields: Record<string, { value: unknown; type?: string }> = buildImageAttachmentFields(input);
  fields.FileSize = { value: input.fileSize, type: "INT64" };
  if (input.isImage === false) {
    delete fields.Width;
    delete fields.Height;
    if (input.fileName) {
      fields.TitleEncrypted = { value: encrypted(input.fileName) };
    }
    if (input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0) {
      fields.Duration = { value: input.durationSeconds, type: "DOUBLE" };
    }
  }
  return fields;
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
