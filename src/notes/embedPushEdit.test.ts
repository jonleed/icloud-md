import { test } from "node:test";
import assert from "node:assert/strict";
import { planEmbedRepresentations } from "./embedPushEdit.js";
import { renderMarkdownTable } from "./markdownTable.js";
import { OBJECT_REPLACEMENT_CHARACTER, type EmbedSlot } from "./noteAttachments.js";
import { formatEmbedMarker } from "./unknownContent.js";

const NO_FILES = new Set<string>();

const GALLERY_SLOT: EmbedSlot = {
  kind: "attachment",
  ref: { attachmentIdentifier: "GALLERY-1", typeUti: "com.apple.notes.gallery" },
};
const GALLERY_MARKER = formatEmbedMarker({ attachmentIdentifier: "GALLERY-1", typeUti: "com.apple.notes.gallery" });
const UNKNOWN_SLOT: EmbedSlot = { kind: "unknown", typeUti: undefined };
const UNKNOWN_MARKER = formatEmbedMarker({});
const TABLE_SLOT: EmbedSlot = {
  kind: "attachment",
  ref: { attachmentIdentifier: "TABLE-1", typeUti: "com.apple.notes.table" },
};

function expectOk(result: ReturnType<typeof planEmbedRepresentations>) {
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectRefusal(result: ReturnType<typeof planEmbedRepresentations>, pattern: RegExp) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.reason, pattern);
}

test("a verbatim marker maps back to its placeholder; edits around it survive", () => {
  const localText = `Title\nedited intro\n${GALLERY_MARKER}\nedited outro`;
  const plan = expectOk(planEmbedRepresentations(localText, [GALLERY_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Title\nedited intro\n${OBJECT_REPLACEMENT_CHARACTER}\nedited outro`);
  assert.deepEqual(plan.tables, []);
});

test("an unknown slot's marker round-trips the same way", () => {
  const localText = `Note\n${UNKNOWN_MARKER}\n`;
  const plan = expectOk(planEmbedRepresentations(localText, [UNKNOWN_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Note\n${OBJECT_REPLACEMENT_CHARACTER}\n`);
});

test("markers and table blocks interleave in document order", () => {
  const table = renderMarkdownTable([["A", "B"]]);
  const localText = `Title\n${GALLERY_MARKER}\nbetween\n${table}\nafter`;
  const plan = expectOk(planEmbedRepresentations(localText, [GALLERY_SLOT, TABLE_SLOT], NO_FILES));
  assert.equal(
    plan.reconstructedBodyText,
    `Title\n${OBJECT_REPLACEMENT_CHARACTER}\nbetween\n${OBJECT_REPLACEMENT_CHARACTER}\nafter`,
  );
  assert.equal(plan.tables.length, 1);
  assert.equal(plan.tables[0]?.ref.attachmentIdentifier, "TABLE-1");
  assert.deepEqual(plan.tables[0]?.block.grid, [["A", "B"]]);
});

test("a table that pull couldn't decode is marker-represented, not table-represented", () => {
  const marker = formatEmbedMarker({ attachmentIdentifier: "TABLE-1", typeUti: "com.apple.notes.table" });
  const localText = `Prose\n${marker}\nmore prose`;
  const plan = expectOk(planEmbedRepresentations(localText, [TABLE_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Prose\n${OBJECT_REPLACEMENT_CHARACTER}\nmore prose`);
  assert.deepEqual(plan.tables, []);
});

test("a deleted marker refuses the push", () => {
  expectRefusal(planEmbedRepresentations("Just prose, marker gone", [GALLERY_SLOT], NO_FILES), /marker.*missing/i);
});

test("an edited marker refuses the push", () => {
  const edited = GALLERY_MARKER.replace(">gallery<", ">my gallery<");
  expectRefusal(planEmbedRepresentations(`Text\n${edited}`, [GALLERY_SLOT], NO_FILES), /edited or is out of order/);
});

test("a duplicated marker refuses the push", () => {
  const localText = `A\n${GALLERY_MARKER}\nB\n${GALLERY_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [GALLERY_SLOT], NO_FILES), /nothing behind it/);
});

test("reordered markers refuse the push", () => {
  const otherSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "GALLERY-2", typeUti: "com.apple.notes.gallery" },
  };
  const otherMarker = formatEmbedMarker({ attachmentIdentifier: "GALLERY-2", typeUti: "com.apple.notes.gallery" });
  const localText = `A\n${otherMarker}\nB\n${GALLERY_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [GALLERY_SLOT, otherSlot], NO_FILES), /edited or is out of order/);
});

test("a hand-added marker with nothing behind it refuses the push", () => {
  const localText = `Only prose\n${UNKNOWN_MARKER}`;
  expectRefusal(planEmbedRepresentations(localText, [], NO_FILES), /nothing behind it/);
});

test("a file attachment tracked from pull keeps the read-only refusal", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  const result = planEmbedRepresentations("![photo](attachments/photo.jpeg)", [fileSlot], new Set(["FILE-1"]));
  expectRefusal(result, /file attachment/);
});

const IMAGE_SLOT: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "IMG-1", typeUti: "public.jpeg" } };
const PDF_SLOT: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "PDF-1", typeUti: "com.adobe.pdf" } };
const LINKS = new Map([
  ["IMG-1", "attachments/photo 1.jpeg"],
  ["PDF-1", "attachments/doc.pdf"],
]);
const IMAGE_LINK = "![photo 1.jpeg](attachments/photo%201.jpeg)";
const PDF_LINK = "[doc.pdf](attachments/doc.pdf)";

test("a verbatim tracked image link maps back to its placeholder; prose around it is editable", () => {
  const localText = `Title\nedited before\n${IMAGE_LINK}\nedited after`;
  const plan = expectOk(planEmbedRepresentations(localText, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS));
  assert.equal(plan.reconstructedBodyText, `Title\nedited before\n${OBJECT_REPLACEMENT_CHARACTER}\nedited after`);
});

test("non-image attachments use their plain-link form", () => {
  const localText = `T\n${PDF_LINK}\n`;
  const plan = expectOk(planEmbedRepresentations(localText, [PDF_SLOT], new Set(LINKS.keys()), LINKS));
  assert.equal(plan.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}\n`);
});

test("file links, markers and tables interleave in document order", () => {
  const table = renderMarkdownTable([["A"]]);
  const localText = `T\n${IMAGE_LINK}\n${GALLERY_MARKER}\n${table}\n${PDF_LINK}`;
  const plan = expectOk(
    planEmbedRepresentations(localText, [IMAGE_SLOT, GALLERY_SLOT, TABLE_SLOT, PDF_SLOT], new Set(LINKS.keys()), LINKS),
  );
  const P = OBJECT_REPLACEMENT_CHARACTER;
  assert.equal(plan.reconstructedBodyText, `T\n${P}\n${P}\n${P}\n${P}`);
  assert.equal(plan.tables.length, 1);
});

test("the same file embedded twice binds both slots in order", () => {
  const localText = `T\n${IMAGE_LINK}\nmid\n${IMAGE_LINK}`;
  const plan = expectOk(planEmbedRepresentations(localText, [IMAGE_SLOT, IMAGE_SLOT], new Set(LINKS.keys()), LINKS));
  assert.equal(plan.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}\nmid\n${OBJECT_REPLACEMENT_CHARACTER}`);
});

test("a deleted image link refuses the push", () => {
  expectRefusal(
    planEmbedRepresentations("T\nprose only", [IMAGE_SLOT], new Set(LINKS.keys()), LINKS),
    /attachment link .* is missing, edited, or out of order/,
  );
});

test("an edited image link (renamed alt text) refuses the push", () => {
  expectRefusal(
    planEmbedRepresentations("T\n![renamed](attachments/photo%201.jpeg)", [IMAGE_SLOT], new Set(LINKS.keys()), LINKS),
    /attachment link/,
  );
});

test("reordered attachment links refuse the push", () => {
  expectRefusal(
    planEmbedRepresentations(`T\n${PDF_LINK}\n${IMAGE_LINK}`, [IMAGE_SLOT, PDF_SLOT], new Set(LINKS.keys()), LINKS),
    /attachment link/,
  );
});

test("a duplicated or hand-typed extra attachment link refuses the push", () => {
  expectRefusal(
    planEmbedRepresentations(`T\n${IMAGE_LINK}\n${IMAGE_LINK}`, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS),
    /extra "attachments\/\.\.\." link/,
  );
  expectRefusal(
    planEmbedRepresentations(`T\n${IMAGE_LINK}\n![new](attachments/new.png)`, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS),
    /extra "attachments\/\.\.\." link/,
  );
});

test("CRLF line endings still match the tracked link", () => {
  const plan = expectOk(
    planEmbedRepresentations(`T\r\n${IMAGE_LINK}\r\nafter`, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS),
  );
  assert.equal(plan.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}\nafter`);
});

test("an identified non-table slot with no marker and no tracked file refuses with the missing-marker reason", () => {
  const fileSlot: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "FILE-1", typeUti: "public.jpeg" } };
  expectRefusal(planEmbedRepresentations("prose only", [fileSlot], NO_FILES), /marker.*is missing/);
});

test("an extra hand-typed table block refuses the push", () => {
  const table = renderMarkdownTable([["A"]]);
  const extra = renderMarkdownTable([["B"]]);
  const localText = `${table}\nprose\n${extra}`;
  expectRefusal(planEmbedRepresentations(localText, [TABLE_SLOT], NO_FILES), /can't tell which table/);
});

test("a missing table block refuses the push", () => {
  expectRefusal(planEmbedRepresentations("prose only", [TABLE_SLOT], NO_FILES), /can't tell which table/);
});

test("a table-only note reconstructs exactly like the old table path did", () => {
  const table = renderMarkdownTable([["Only", "Content"]]);
  const plan = expectOk(planEmbedRepresentations(table, [TABLE_SLOT], NO_FILES));
  assert.equal(plan.reconstructedBodyText, OBJECT_REPLACEMENT_CHARACTER);
});

test("two tables reconstruct in document order", () => {
  const first = renderMarkdownTable([["First"]]);
  const second = renderMarkdownTable([["Second", "Table"]]);
  const secondSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "TABLE-2", typeUti: "com.apple.notes.table" },
  };
  const localText = `Intro\n${first}\nMiddle\n${second}\nOutro`;
  const plan = expectOk(planEmbedRepresentations(localText, [TABLE_SLOT, secondSlot], NO_FILES));
  assert.equal(
    plan.reconstructedBodyText,
    `Intro\n${OBJECT_REPLACEMENT_CHARACTER}\nMiddle\n${OBJECT_REPLACEMENT_CHARACTER}\nOutro`,
  );
  assert.deepEqual(
    plan.tables.map((t) => t.ref.attachmentIdentifier),
    ["TABLE-1", "TABLE-2"],
  );
});

test("mixed local separators normalize before locating multiple tables and markers", () => {
  const firstTable = renderMarkdownTable([["First", "Value"]]);
  const secondTable = renderMarkdownTable([["Second"]]);
  const secondTableSlot: EmbedSlot = {
    kind: "attachment",
    ref: { attachmentIdentifier: "TABLE-2", typeUti: "com.apple.notes.table" },
  };
  const localText = [
    "Intro",
    GALLERY_MARKER,
    "between marker and table",
    firstTable,
    "between tables",
    UNKNOWN_MARKER,
    secondTable,
    "Outro",
  ].join("\r\n").replace("Intro\r\n", "Intro\r").replace("\r\nOutro", "\nOutro");
  for (const input of [localText, localText.replace(/\r\n?|\n/g, "\r"), localText.replace(/\r\n?|\n/g, "\r\n")]) {
    const plan = expectOk(planEmbedRepresentations(
      input,
      [GALLERY_SLOT, TABLE_SLOT, UNKNOWN_SLOT, secondTableSlot],
      NO_FILES,
    ));
    assert.equal(
      plan.reconstructedBodyText,
      ["Intro", OBJECT_REPLACEMENT_CHARACTER, "between marker and table", OBJECT_REPLACEMENT_CHARACTER,
        "between tables", OBJECT_REPLACEMENT_CHARACTER, OBJECT_REPLACEMENT_CHARACTER, "Outro"].join("\n"),
    );
    assert.deepEqual(
      plan.tables.map(({ ref, block }) => [ref.attachmentIdentifier, block.grid]),
      [["TABLE-1", [["First", "Value"]]], ["TABLE-2", [["Second"]]]],
    );
  }
});
