import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../js/calc.js";
import { normalise, emptyData } from "../js/store.js";

const e = (d, a, extra = {}) => ({ id: d + a + Math.random(), type: "exp", d, a, c: "food", n: "", pm: "cash", ...extra });

test("parseAmount handles commas, decimals and simple sums", () => {
  assert.equal(C.parseAmount("1,250"), 1250);
  assert.equal(C.parseAmount("99.5"), 99.5);
  assert.equal(C.parseAmount("250+120-20"), 350);
  assert.equal(C.parseAmount(" 0.1+0.2 "), 0.3);
  assert.ok(Number.isNaN(C.parseAmount("abc")));
  assert.ok(Number.isNaN(C.parseAmount("2*3")));
  assert.ok(Number.isNaN(C.parseAmount("")));
});

test("weeks start on Monday and weekend is Sat+Sun", () => {
  const sun = C.fromISO("2026-10-11"); // a Sunday
  assert.equal(C.weekdayIndex(sun), 6);
  assert.equal(C.toISO(C.startOfWeek(sun)), "2026-10-05");
  assert.ok(C.isWeekend(sun));
  assert.ok(!C.isWeekend(C.fromISO("2026-10-09")));
});

test("weekSummary splits weekday and weekend totals", () => {
  const entries = [e("2026-10-05", 100), e("2026-10-09", 50.25), e("2026-10-10", 200), e("2026-10-11", 300), e("2026-10-12", 999),
    { ...e("2026-10-10", 5000), type: "inc" }];
  const w = C.weekSummary(entries, C.fromISO("2026-10-05"));
  assert.equal(w.weekday, 150.25);
  assert.equal(w.weekend, 500);
  assert.equal(w.total, 650.25);
  assert.deepEqual(w.perDay, [100, 0, 0, 0, 50.25, 200, 300]);
});

test("monthSummary totals, average, balance and weeks", () => {
  const entries = [e("2026-10-01", 1000), e("2026-10-10", 400), e("2026-10-11", 600, { c: "transport" }), e("2026-09-30", 7777),
    { ...e("2026-10-01", 80000), type: "inc", c: "salary" }];
  const s = C.monthSummary(entries, 2026, 9, C.fromISO("2026-10-11"));
  assert.equal(s.total, 2000);
  assert.equal(s.income, 80000);
  assert.equal(s.balance, 78000);
  assert.equal(s.weekend, 1000);              // 10th (Sat) + 11th (Sun)
  assert.equal(s.average, Math.round((2000 / 11) * 100) / 100);
  assert.equal(s.topDay, 0);
  assert.deepEqual(s.byCategory, [["food", 1400], ["transport", 600]]);
  assert.equal(s.weeks[0].from, "2026-10-01");
  assert.equal(s.weeks.at(-1).to, "2026-10-31");
  assert.equal(s.weeks.reduce((a, w) => a + w.total, 0), 2000);
});

test("past months use all their days for the average", () => {
  const s = C.monthSummary([e("2026-02-10", 280)], 2026, 1, C.fromISO("2026-10-11"));
  assert.equal(s.days, 28);
  assert.equal(s.average, 10);
});

test("dueRecurring creates each month once and clamps the day", () => {
  const r = { id: "rent", type: "exp", a: 25000, c: "home", n: "Rent", pm: "online", day: 31, start: "2026-08-01" };
  const { entries, last } = C.dueRecurring([r], C.fromISO("2026-10-11"));
  assert.deepEqual(entries.map((x) => x.d), ["2026-08-31", "2026-09-30"]); // October's 31st hasn't come yet
  assert.equal(entries[0].id, "rec-rent-2026-08");
  assert.equal(last.rent, "2026-09");
  const again = C.dueRecurring([{ ...r, last: "2026-09" }], C.fromISO("2026-10-11"));
  assert.equal(again.entries.length, 0);
  const later = C.dueRecurring([{ ...r, last: "2026-09" }], C.fromISO("2026-10-31"));
  assert.deepEqual(later.entries.map((x) => x.d), ["2026-10-31"]);
  assert.equal(C.dueRecurring([{ ...r, paused: true }], C.fromISO("2026-10-31")).entries.length, 0);
});

test("frequentCombos needs at least two repeats", () => {
  const today = C.fromISO("2026-10-11");
  const entries = [e("2026-10-01", 100, { n: "Bus" }), e("2026-10-02", 100, { n: "Bus" }), e("2026-10-03", 450, { n: "Lunch" })];
  assert.deepEqual(C.frequentCombos(entries, today), [{ c: "food", a: 100, n: "Bus", pm: "cash" }]);
});

test("CSV has a BOM, header and escaped notes", () => {
  const csv = C.toCSV([e("2026-10-01", 10, { n: 'say "hi"' })], () => "කෑම", () => "Cash");
  assert.ok(csv.startsWith("﻿date,type,category"));
  assert.ok(csv.includes('"say ""hi"""'));
  assert.ok(csv.includes('"කෑම"'));
});

test("normalise drops bad entries and repairs missing categories", () => {
  const d = normalise({ entries: [{ id: "a", d: "2026-10-01", a: 10, c: "gone" }, { id: "b", d: "bad", a: 5, c: "food" }, { id: "c", d: "2026-10-01", a: -3, c: "food" }] });
  assert.equal(d.entries.length, 1);
  assert.equal(d.entries[0].c, "other");
  assert.equal(d.settings.lang, "si");
  assert.equal(normalise(null).categories.length, emptyData().categories.length);
});
