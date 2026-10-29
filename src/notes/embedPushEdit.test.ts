import { test } from "node:test";
import assert from "node:assert/strict";
import { hasVaultEmbed, planEmbedRepresentations, resolveVaultFile } from "./embedPushEdit.js";
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

test("a tracked attachment matches in either link form, and a typed \"!\" never survives as text", () => {
  // A file rendered as a plain link before its type was known to be an
  // image (WebP, under Apple's "org.webmproject.webp"), and the reverse.
  const asLink = expectOk(planEmbedRepresentations(`T\n${IMAGE_LINK.slice(1)}\n`, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS));
  assert.equal(asLink.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}\n`);
  const asEmbed = expectOk(planEmbedRepresentations(`T\n!${PDF_LINK}\n`, [PDF_SLOT], new Set(LINKS.keys()), LINKS));
  assert.equal(asEmbed.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}\n`, "the ! belongs to the link, not the text");
});

test("a \"!\" ending the previous attachment's link is not taken for the next one", () => {
  const twoPdfs: EmbedSlot = { kind: "attachment", ref: { attachmentIdentifier: "PDF-2", typeUti: "com.adobe.pdf" } };
  const links = new Map([...LINKS, ["PDF-2", "attachments/two.pdf"]]);
  const plan = expectOk(planEmbedRepresentations(`T\n${PDF_LINK}![two.pdf](attachments/two.pdf)!\n`, [PDF_SLOT, twoPdfs], new Set(links.keys()), links));
  assert.equal(plan.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}${OBJECT_REPLACEMENT_CHARACTER}!\n`);
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

test("a hand-typed or duplicated attachment link on its own line becomes a new attachment", () => {
  const dup = expectOk(planEmbedRepresentations(`T\n${IMAGE_LINK}\n${IMAGE_LINK}`, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS));
  assert.deepEqual(dup.newAttachments, [
    { ordinal: 1, linkText: IMAGE_LINK, href: "attachments/photo 1.jpeg", isImage: true },
  ]);
  const P = OBJECT_REPLACEMENT_CHARACTER;
  assert.equal(dup.reconstructedBodyText, `T\n${P}\n${P}`);

  const fresh = expectOk(
    planEmbedRepresentations(`T\n![new](attachments/new%20pic.png)\n${IMAGE_LINK}`, [IMAGE_SLOT], new Set(LINKS.keys()), LINKS),
  );
  assert.deepEqual(fresh.newAttachments, [
    { ordinal: 0, linkText: "![new](attachments/new%20pic.png)", href: "attachments/new pic.png", isImage: true },
  ]);
  assert.equal(fresh.reconstructedBodyText, `T\n${P}\n${P}`);
});

test("a new attachment link in a note with no embeds yet", () => {
  const plan = expectOk(planEmbedRepresentations("Title\nintro\n![a](attachments/a.png)\nafter\n", [], NO_FILES));
  assert.equal(plan.reconstructedBodyText, `Title\nintro\n${OBJECT_REPLACEMENT_CHARACTER}\nafter\n`);
  assert.equal(plan.newAttachments.length, 1);
  assert.equal(plan.newAttachments[0]?.ordinal, 0);
});

test("a new attachment link sharing its line with prose refuses the push", () => {
  expectRefusal(
    planEmbedRepresentations("T\nsee ![a](attachments/a.png) here", [], NO_FILES),
    /must be on a line of its own/,
  );
});

test("existing embeds still map to their own placeholders when new ones interleave", () => {
  const P = OBJECT_REPLACEMENT_CHARACTER;
  const plan = expectOk(
    planEmbedRepresentations(
      `T\n![n1](attachments/n1.png)\n${GALLERY_MARKER}\n![n2](attachments/n2.png)\n${PDF_LINK}`,
      [GALLERY_SLOT, PDF_SLOT],
      new Set(LINKS.keys()),
      LINKS,
    ),
  );
  assert.equal(plan.reconstructedBodyText, `T\n${P}\n${P}\n${P}\n${P}`);
  assert.deepEqual(
    plan.newAttachments.map((n) => [n.ordinal, n.href]),
    [
      [0, "attachments/n1.png"],
      [2, "attachments/n2.png"],
    ],
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

// --- Obsidian-style embeds ---------------------------------------------------

const VAULT = {
  noteDir: "Notes",
  files: new Set([
    "Pasted image 20261029.png",
    "Notes/beside.jpg",
    "Notes/attachments/inside.png",
    "Assets/deep/scan.pdf",
    "Recipes/dup.png",
    "Travel/dup.png",
  ]),
};

test("resolveVaultFile follows Obsidian's lookup: beside the note, attachments/, then a unique name anywhere", () => {
  assert.equal(resolveVaultFile("beside.jpg", VAULT), "Notes/beside.jpg");
  assert.equal(resolveVaultFile("inside.png", VAULT), "Notes/attachments/inside.png");
  assert.equal(resolveVaultFile("Pasted image 20261029.png", VAULT), "Pasted image 20261029.png");
  assert.equal(resolveVaultFile("Assets/deep/scan.pdf", VAULT), "Assets/deep/scan.pdf", "a vault-root path");
  assert.equal(resolveVaultFile("../Assets/deep/scan.pdf", VAULT), "Assets/deep/scan.pdf", "a note-relative path");
  assert.equal(resolveVaultFile("dup.png", VAULT), "ambiguous");
  assert.equal(resolveVaultFile("missing.png", VAULT), undefined);
  assert.equal(resolveVaultFile("../../outside.png", VAULT), undefined);
});

test("an Obsidian wikilink embed of a vault file becomes a new attachment; alias and heading are dropped", () => {
  const plan = expectOk(
    planEmbedRepresentations("T\n![[Pasted image 20261029.png]]\n![[scan.pdf|300]]\n", [], new Set(), new Map(), VAULT),
  );
  assert.equal(plan.reconstructedBodyText, `T\n${OBJECT_REPLACEMENT_CHARACTER}\n${OBJECT_REPLACEMENT_CHARACTER}\n`);
  assert.deepEqual(
    plan.newAttachments.map((link) => [link.ordinal, link.linkText, link.vaultPath, link.isImage]),
    [
      [0, "![[Pasted image 20261029.png]]", "Pasted image 20261029.png", true],
      [1, "![[scan.pdf|300]]", "Assets/deep/scan.pdf", true],
    ],
  );
});

test("a markdown link to a vault file outside attachments/ becomes a new attachment too", () => {
  const plan = expectOk(planEmbedRepresentations("T\n![](../Pasted%20image%2020261029.png)\n", [], new Set(), new Map(), VAULT));
  assert.equal(plan.newAttachments[0]?.vaultPath, "Pasted image 20261029.png");
});

test("embeds that name no vault file stay literal text: URLs, notes, missing files", () => {
  const text = "T\n![[Another note]]\n![[missing.png]]\n![x](https://example.com/a.png)\n[home](#top)\n";
  const plan = expectOk(planEmbedRepresentations(text, [], new Set(), new Map(), VAULT));
  assert.equal(plan.reconstructedBodyText, text);
  assert.deepEqual(plan.newAttachments, []);
});

test("an ambiguous or inline Obsidian embed refuses the push", () => {
  expectRefusal(planEmbedRepresentations("T\n![[dup.png]]\n", [], new Set(), new Map(), VAULT), /more than one file/);
  expectRefusal(planEmbedRepresentations("T see ![[beside.jpg]] here\n", [], new Set(), new Map(), VAULT), /line of its own/);
});

test("without the vault's files, Obsidian embeds are plain text exactly as before", () => {
  const plan = expectOk(planEmbedRepresentations("T\n![[beside.jpg]]\n", [], new Set(), new Map()));
  assert.equal(plan.reconstructedBodyText, "T\n![[beside.jpg]]\n");
  assert.equal(hasVaultEmbed("T\n![[beside.jpg]]\n", VAULT), true);
  assert.equal(hasVaultEmbed("T\n![[missing.png]]\n", VAULT), false);
  assert.equal(hasVaultEmbed("T\n![[beside.jpg]]\n", undefined), false);
});
