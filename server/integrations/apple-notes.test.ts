import { describe, it, expect } from "vitest";
import {
  htmlToPlainText,
  plainTextToHtml,
  buildListFoldersScript,
  buildListNotesScript,
  buildSearchNotesScript,
  buildReadNoteScript,
  buildCreateNoteScript,
  buildAppendToNoteScript,
  buildUpdateNoteScript,
  buildDeleteNoteScript,
} from "./apple-notes.js";

describe("html helpers", () => {
  it("strips tags and converts <br> to newlines", () => {
    expect(htmlToPlainText("<div>hello<br/>world</div>")).toBe("hello\nworld");
  });

  it("converts <li> to '- ' bullets", () => {
    expect(htmlToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });

  it("decodes html entities", () => {
    expect(htmlToPlainText("&amp; &lt;x&gt; &quot;y&quot;")).toBe('& <x> "y"');
  });

  it("plain → html: wraps newlines as <br>", () => {
    expect(plainTextToHtml("a\nb")).toBe("a<br>b");
  });

  it("plain → html: '- ' lines become <li>", () => {
    const out = plainTextToHtml("- a\n- b");
    expect(out).toContain("<li>a</li>");
    expect(out).toContain("<li>b</li>");
  });

  it("plain → html → plain round-trip: text before bullets keeps separator", () => {
    const input = "intro\n- a\n- b";
    const html = plainTextToHtml(input);
    const back = htmlToPlainText(html);
    expect(back).toBe("intro\n- a\n- b");
  });

  it("plain → html → plain round-trip: bullets between text", () => {
    const input = "x\n- a\n- b\ny";
    const html = plainTextToHtml(input);
    const back = htmlToPlainText(html);
    expect(back).toMatch(/^x\n- a\n- b\n+y$/);
  });
});

describe("apple-notes script builders", () => {
  it("list_folders: returns JXA", () => {
    const s = buildListFoldersScript();
    expect(s).toContain("Application('Notes')");
    expect(s).toContain("JSON.stringify");
  });

  it("list_notes: filters by folder", () => {
    const s = buildListNotesScript({ folder: "Work", limit: 25 });
    expect(s).toContain(`"Work"`);
    expect(s).toContain("25");
  });

  it("search_notes: lowercases query", () => {
    const s = buildSearchNotesScript({ query: "APARTMENT", limit: 50 });
    expect(s).toContain("apartment");
  });

  it("read_note: includes id literal", () => {
    const s = buildReadNoteScript({ id: "x-coredata://abc" });
    expect(s).toContain(`"x-coredata://abc"`);
  });
});

describe("apple-notes write builders", () => {
  it("create_note: makes a Note in the named folder", () => {
    const s = buildCreateNoteScript({
      title: "Trip plans",
      body: "- Flight\n- Hotel",
      folder: "Travel",
    });
    expect(s).toContain(`"Travel"`);
    expect(s).toContain("Notes.Note");
    expect(s).toContain(`"Trip plans"`);
  });

  it("append_to_note: appends body content", () => {
    const s = buildAppendToNoteScript({ id: "x-coredata://abc", content: "extra" });
    expect(s).toContain(`"x-coredata://abc"`);
    expect(s).toContain("extra");
  });

  it("update_note: replaces title or body", () => {
    const s = buildUpdateNoteScript({ id: "x-coredata://abc", title: "new" });
    expect(s).toContain(`"new"`);
  });

  it("delete_note: deletes by id", () => {
    const s = buildDeleteNoteScript({ id: "x-coredata://abc" });
    expect(s).toContain(".delete()");
  });
});
