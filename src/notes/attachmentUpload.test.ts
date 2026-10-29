import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { create } from "@bufbuild/protobuf";
import {
  attachNewEmbeds,
  buildImageAttachmentFields,
  buildMediaFields,
  detectImage,
} from "./attachmentUpload.js";
import { AttributeRunSchema, ParagraphStyleSchema } from "./gen/topotext_pb.js";
import type { NoteDocument } from "./noteDocument.js";

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Minimal baseline JPEG header: SOI, an APP0 segment, then SOF0. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0", "latin1"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

test("detectImage reads PNG and JPEG dimensions from their headers", () => {
  assert.deepEqual(detectImage(png(12, 7)), { uti: "public.png", width: 12, height: 7 });
  assert.deepEqual(detectImage(jpeg(736, 776)), { uti: "public.jpeg", width: 736, height: 776 });
});

test("detectImage recognizes GIF, WebP, HEIC and TIFF by magic bytes", () => {
  const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([5, 0, 9, 0]), Buffer.alloc(8)]);
  assert.deepEqual(detectImage(gif), { uti: "com.compuserve.gif", width: 5, height: 9 });

  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0, "latin1");
  vp8x.write("WEBP", 8, "latin1");
  vp8x.write("VP8X", 12, "latin1");
  vp8x.writeUIntLE(99, 24, 3);
  vp8x.writeUIntLE(49, 27, 3);
  assert.deepEqual(detectImage(vp8x), { uti: "public.webp", width: 100, height: 50 });

  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(12)]);
  assert.deepEqual(detectImage(heic), { uti: "public.heic" });
  assert.deepEqual(detectImage(Buffer.from("II*\0rest", "latin1")), { uti: "public.tiff" });
});

test("detectImage rejects non-images whatever their name", () => {
  assert.equal(detectImage(Buffer.from("%PDF-1.7\n")), undefined);
  assert.equal(detectImage(Buffer.from("not an image at all")), undefined);
  assert.equal(detectImage(Buffer.alloc(0)), undefined);
});

test("Media and Attachment fields match the native image record shape", () => {
  const asset = { fileChecksum: "c", size: 3, wrappingKey: "w", referenceChecksum: "r", receipt: "x" };
  assert.deepEqual(buildMediaFields("pic 1.png", asset), {
    Asset: { value: asset },
    FilenameEncrypted: { value: Buffer.from("pic 1.png").toString("base64") },
    Deleted: { value: 0 },
    MinimumSupportedNotesVersion: { value: 0 },
  });
  const fields = buildImageAttachmentFields({
    noteRecordName: "NOTE",
    mediaRecordName: "MEDIA",
    zoneName: "Notes",
    uti: "public.png",
    fileSize: 1234,
    width: 12,
    height: 7,
    nowMs: 1700000000000,
  });
  assert.deepEqual(fields.Media, { value: { recordName: "MEDIA", action: "VALIDATE", zoneID: { zoneName: "Notes" } } });
  assert.deepEqual(fields.Note, { value: { recordName: "NOTE", action: "VALIDATE", zoneID: { zoneName: "Notes" } } });
  assert.deepEqual(fields.UTI, { value: "public.png" });
  assert.deepEqual(fields.UTIEncrypted, { value: Buffer.from("public.png").toString("base64") });
  assert.deepEqual([fields.Width, fields.Height, fields.FileSize], [{ value: 12 }, { value: 7 }, { value: 1234 }]);
  assert.deepEqual(fields.Orientation, { value: 0 });

  const noDims = buildImageAttachmentFields({
    noteRecordName: "N",
    mediaRecordName: "M",
    zoneName: "Notes",
    uti: "public.heic",
    fileSize: 1,
    nowMs: 1,
  });
  assert.equal("Width" in noDims || "Height" in noDims, false);
});

function docWithRuns(text: string, lengths: number[]): NoteDocument {
  return {
    text,
    attributeRuns: lengths.map((length, i) =>
      create(AttributeRunSchema, { length, paragraphStyle: create(ParagraphStyleSchema, { style: i === 0 ? 0 : 3 }) }),
    ),
  } as unknown as NoteDocument;
}

test("attachNewEmbeds isolates each placeholder in its own run, keeping paragraph style", () => {
  // "Title\n" (title run) + "\uFFFC\nafter\n" merged into one body run, the
  // way applyTextEdit leaves freshly inserted text.
  const doc = docWithRuns("Title\n\uFFFC\nafter\n", [6, 8]);
  attachNewEmbeds(doc, [{ index: 6, attachmentIdentifier: "ATT-1", typeUti: "public.png" }], 1792000000);
  const runs = doc.attributeRuns;
  assert.deepEqual(
    runs.map((run) => run.length),
    [6, 1, 7],
  );
  const embed = runs[1];
  assert.equal(embed?.attachmentInfo?.attachmentIdentifier, "ATT-1");
  assert.equal(embed?.attachmentInfo?.typeUTI, "public.png");
  assert.equal(embed?.timestamp, 1792000000n);
  assert.equal(embed?.paragraphStyle?.style, 3);
  assert.equal(runs[2]?.attachmentInfo, undefined);
});

test("attachNewEmbeds handles several placeholders and refuses a non-placeholder offset", () => {
  const doc = docWithRuns("T\n\uFFFC\n\uFFFC\n", [2, 4]);
  attachNewEmbeds(
    doc,
    [
      { index: 2, attachmentIdentifier: "A", typeUti: "public.png" },
      { index: 4, attachmentIdentifier: "B", typeUti: "public.jpeg" },
    ],
    1,
  );
  assert.deepEqual(
    doc.attributeRuns.map((run) => [run.length, run.attachmentInfo?.attachmentIdentifier ?? null]),
    [
      [2, null],
      [1, "A"],
      [1, null],
      [1, "B"],
      [1, null],
    ],
  );
  assert.throws(() => attachNewEmbeds(docWithRuns("T\nx\n", [2, 2]), [{ index: 2, attachmentIdentifier: "C", typeUti: "public.png" }], 1));
});
