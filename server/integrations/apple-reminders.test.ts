import { describe, it, expect } from "vitest";
import {
  buildListListsScript,
  buildListRemindersScript,
  buildSearchRemindersScript,
  buildGetReminderScript,
  formatDue,
} from "./apple-reminders.js";

describe("apple-reminders script builders", () => {
  it("list_lists: returns JXA that JSON-stringifies the lists array", () => {
    const s = buildListListsScript();
    expect(s).toContain("Application('Reminders')");
    expect(s).toContain("JSON.stringify");
  });

  it("list_reminders: interpolates list name as JSON literal", () => {
    const s = buildListRemindersScript({ list: "Personal", status: "incomplete" });
    expect(s).toContain(`"Personal"`);
    expect(s).toContain("JSON.stringify");
  });

  it("list_reminders: handles quotes in list name safely", () => {
    const s = buildListRemindersScript({ list: `bad "name"` });
    expect(s).toContain(`"bad \\"name\\""`);
  });

  it("search_reminders: lowercases and substring-matches", () => {
    const s = buildSearchRemindersScript({ query: "DENTIST", limit: 25 });
    expect(s).toContain("dentist");
    expect(s).toContain("25");
  });

  it("get_reminder: includes id literal", () => {
    const s = buildGetReminderScript({
      id: "x-apple-reminderkit://REMCDReminder/abc-123",
    });
    expect(s).toContain(`"x-apple-reminderkit://REMCDReminder/abc-123"`);
  });
});

describe("formatDue", () => {
  it("formats a non-midnight datetime in local tz", () => {
    // Use an explicit local-time constructor so the test is TZ-independent.
    // April 29, 2026 5:00 PM local.
    const d = new Date(2026, 3, 29, 17, 0, 0);
    expect(formatDue(d.toISOString())).toBe("due 2026-04-29 17:00");
  });

  it("omits time at local midnight", () => {
    const d = new Date(2026, 3, 29, 0, 0, 0);
    expect(formatDue(d.toISOString())).toBe("due 2026-04-29");
  });

  it("returns 'no due date' for null", () => {
    expect(formatDue(null)).toBe("no due date");
  });
});
