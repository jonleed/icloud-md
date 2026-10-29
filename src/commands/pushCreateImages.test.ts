import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeNoteEmbedSlots } from "../notes/noteAttachments.js";
import { parseNoteDocument, replicaTableIsSorted } from "../notes/noteDocument.js";
import { decodeNoteBodyText, decompressNoteDocument } from "../notes/noteText.js";
import { planEmbedRepresentations } from "../notes/embedPushEdit.js";
import { prepareNoteCreate, takeAttachmentFiles } from "./push.js";

/**
 * A brand-new note that carries images. Push plans it by turning each
 * `attachments/...` image line into a placeholder (the same planner edits
 * use), then builds the note with one attachment run per placeholder.
 */

const REPLICA = new Uint8Array(16).fill(0x37);
const JPEG = { attachmentRecordName: "AAAA0000-0000-4000-8000-000000000001", uti: "public.jpeg" };
const PNG = { attachmentRecordName: "BBBB0000-0000-4000-8000-000000000002", uti: "public.png" };

function placeholders(markdown: string): string {
  const plan = planEmbedRepresentations(markdown, [], new Set(), new Map());
  assert.ok(plan.ok, plan.ok ? "" : plan.reason);
  return plan.reconstructedBodyText;
}

function decode(payloadBase64: string) {
  const compressed = Buffer.from(payloadBase64, "base64");
  return {
    text: decodeNoteBodyText(compressed),
    slots: decodeNoteEmbedSlots(compressed),
    doc: parseNoteDocument(new Uint8Array(decompressNoteDocument(compressed))),
  };
}

test("a new note with images is built with one attachment run per image, in order", () => {
  const source = placeholders("New note\nAbove.\n![a](attachments/a.jpg)\nBetween.\n![b](attachments/b.png)\nBelow.\n");

  const built = prepareNoteCreate(source, "Notes/New note.md", "in-body", new Map(), REPLICA, [JPEG, PNG]);

  assert.ok(built.ok, built.ok ? "" : built.reason);
  const { text, slots, doc } = decode(built.payloadBase64);
  assert.equal(text, "New note\nAbove.\n\ufffc\nBetween.\n\ufffc\nBelow.\n");
  assert.deepEqual(
    slots?.map((slot) => (slot.kind === "attachment" ? slot.ref : slot)),
    [
      { attachmentIdentifier: JPEG.attachmentRecordName, typeUti: JPEG.uti },
      { attachmentIdentifier: PNG.attachmentRecordName, typeUti: PNG.uti },
    ],
  );
  assert.ok(replicaTableIsSorted(doc.replicas));
  assert.equal(built.plainText, text);
});

test("a new note's images can't be fewer or more than its placeholders", () => {
  const source = placeholders("New\n![a](attachments/a.jpg)\n");

  const tooMany = prepareNoteCreate(source, "Notes/New.md", "in-body", new Map(), REPLICA, [JPEG, PNG]);
  const none = prepareNoteCreate(source, "Notes/New.md", "in-body", new Map(), REPLICA, []);

  assert.equal(tooMany.ok, false);
  assert.equal(none.ok, false, "a bare placeholder with no attachment record must never be sent");
});

test("a new note's image survives filename-as-title, where the title comes from the file name", () => {
  const source = placeholders("Above.\n![a](attachments/a.jpg)\n");

  const built = prepareNoteCreate(source, "Notes/From the file name.md", "filename", new Map(), REPLICA, [JPEG]);

  assert.ok(built.ok, built.ok ? "" : built.reason);
  const { text, slots } = decode(built.payloadBase64);
  assert.equal(text, "From the file name\nAbove.\n\ufffc\n");
  assert.equal(slots?.length, 1);
});

test("a new note with no images still builds exactly as before", () => {
  const built = prepareNoteCreate("Plain\nJust text.\n", "Notes/Plain.md", "in-body", new Map(), REPLICA, []);

  assert.ok(built.ok);
  assert.equal(decode(built.payloadBase64).text, "Plain\nJust text.\n");
  assert.deepEqual(decode(built.payloadBase64).slots, []);
});

test("an image file belongs to one note: a second claim, or the same file twice in one note, is refused", () => {
  const claimed = new Set(["Notes/attachments/tracked.jpg"]);

  assert.equal(takeAttachmentFiles(claimed, [{ file: "Notes/attachments/tracked.jpg" }]), "Notes/attachments/tracked.jpg");
  assert.equal(takeAttachmentFiles(claimed, [{ file: "Notes/attachments/new.jpg" }, { file: "Notes/attachments/new.jpg" }]), "Notes/attachments/new.jpg");
  assert.equal(claimed.has("Notes/attachments/new.jpg"), false, "a refused note claims nothing");

  assert.equal(takeAttachmentFiles(claimed, [{ file: "Notes/attachments/new.jpg" }]), undefined);
  assert.equal(takeAttachmentFiles(claimed, [{ file: "Notes/attachments/new.jpg" }]), "Notes/attachments/new.jpg", "the next note can't reuse it");
});

test("a new note can carry a non-image file, which keeps its plain-link placeholder", () => {
  const pdf = { attachmentRecordName: "CCCC0000-0000-4000-8000-000000000003", uti: "com.adobe.pdf" };
  const source = placeholders("Receipts\n[receipt.pdf](attachments/receipt.pdf)\n");

  const built = prepareNoteCreate(source, "Notes/Receipts.md", "in-body", new Map(), REPLICA, [pdf]);

  assert.ok(built.ok, built.ok ? "" : built.reason);
  const { text, slots } = decode(built.payloadBase64);
  assert.equal(text, "Receipts\n\ufffc\n");
  assert.deepEqual(slots?.map((slot) => (slot.kind === "attachment" ? slot.ref.typeUti : slot.kind)), ["com.adobe.pdf"]);
});

test("a file about to move into attachments/ claims both its place and its destination", () => {
  const claimed = new Set<string>();

  assert.equal(takeAttachmentFiles(claimed, [{ file: "Notes/attachments/p.png", moveFrom: "p.png" }]), undefined);
  assert.equal(
    takeAttachmentFiles(claimed, [{ file: "Recipes/attachments/p.png", moveFrom: "p.png" }]),
    "p.png",
    "a second note embedding the same pasted file is refused - the first push moves it away",
  );
});
