// Pure date and money helpers. No DOM access here, so everything is unit-tested in tests/calc.test.js.

export const pad = (n) => String(n).padStart(2, "0");

/** Local date -> "YYYY-MM-DD" */
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "YYYY-MM-DD" -> local Date at midnight */
export const fromISO = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (d, n) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
};

/** 0 = Monday … 6 = Sunday */
export const weekdayIndex = (d) => (d.getDay() + 6) % 7;
export const isWeekend = (d) => weekdayIndex(d) >= 5;

/** Monday of the week containing d */
export const startOfWeek = (d) => addDays(d, -weekdayIndex(d));

export const monthBounds = (year, month) => [new Date(year, month, 1), new Date(year, month + 1, 0)];

export const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

/** Round to cents to avoid floating point drift */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const sum = (entries) => round2(entries.reduce((s, e) => s + e.a, 0));

export const between = (entries, fromISOStr, toISOStr) =>
  entries.filter((e) => e.d >= fromISOStr && e.d <= toISOStr);

export const expenses = (entries) => entries.filter((e) => e.type !== "inc");
export const incomes = (entries) => entries.filter((e) => e.type === "inc");

/**
 * Parse an amount typed by the user. Accepts "1,250", "1250.50" and simple sums like "250+120-20".
 * Returns NaN for anything else.
 */
export function parseAmount(input) {
  const s = String(input ?? "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?([+-]\d+(\.\d+)?)*$/.test(s)) return NaN;
  const parts = s.match(/[+-]?\d+(\.\d+)?/g);
  return round2(parts.reduce((t, p) => t + parseFloat(p), 0));
}

/** Totals grouped by a key function, sorted largest first */
export function groupTotals(entries, keyFn) {
  const map = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    map.set(k, round2((map.get(k) || 0) + e.a));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Week summary: per-day expense totals Mon..Sun, weekday and weekend totals */
export function weekSummary(entries, monday) {
  const days = Array.from({ length: 7 }, (_, i) => toISO(addDays(monday, i)));
  const exp = expenses(between(entries, days[0], days[6]));
  const perDay = days.map((d) => sum(exp.filter((e) => e.d === d)));
  const weekday = round2(perDay.slice(0, 5).reduce((a, b) => a + b, 0));
  const weekend = round2(perDay[5] + perDay[6]);
  return { days, perDay, weekday, weekend, total: round2(weekday + weekend), entries: exp };
}

/**
 * Month summary. `today` decides how many days have passed in the current month (for the daily average).
 */
export function monthSummary(entries, year, month, today = new Date()) {
  const [first, last] = monthBounds(year, month);
  const from = toISO(first), to = toISO(last);
  const inMonth = between(entries, from, to);
  const exp = expenses(inMonth);
  const inc = incomes(inMonth);
  const n = last.getDate();
  const perDay = Array(n).fill(0);
  let weekend = 0;
  for (const e of exp) {
    const d = fromISO(e.d);
    perDay[d.getDate() - 1] = round2(perDay[d.getDate() - 1] + e.a);
    if (isWeekend(d)) weekend = round2(weekend + e.a);
  }
  const total = sum(exp);
  const income = sum(inc);
  const isCurrent = today.getFullYear() === year && today.getMonth() === month;
  const isFuture = first > today;
  const elapsed = isFuture ? 0 : isCurrent ? today.getDate() : n;
  let topDay = -1;
  perDay.forEach((v, i) => { if (v > 0 && (topDay < 0 || v > perDay[topDay])) topDay = i; });

  // weeks (Mon–Sun) clipped to the month
  const weeks = [];
  for (let s = startOfWeek(first); s <= last; s = addDays(s, 7)) {
    const ws = s < first ? first : s;
    const we = addDays(s, 6) > last ? last : addDays(s, 6);
    const items = between(exp, toISO(ws), toISO(we));
    weeks.push({ from: toISO(ws), to: toISO(we), total: sum(items), weekend: sum(items.filter((e) => isWeekend(fromISO(e.d)))) });
  }
  return {
    from, to, days: n, perDay, weekend, total, income,
    balance: round2(income - total),
    count: exp.length,
    average: elapsed ? round2(total / elapsed) : 0,
    // fixed monthly items (rent, bills) count once; only day-to-day spending is extrapolated
    projected: isCurrent && elapsed ? round2(sum(exp.filter((e) => e.rec)) + (sum(exp.filter((e) => !e.rec)) / elapsed) * n) : total,
    elapsed,
    topDay,
    weeks,
    byCategory: groupTotals(exp, (e) => e.c),
    byMethod: groupTotals(exp, (e) => e.pm || "cash"),
    expenses: exp,
    incomes: inc,
  };
}

/** Year summary: monthly expense and income totals */
export function yearSummary(entries, year) {
  const months = Array.from({ length: 12 }, (_, m) => {
    const [f, l] = monthBounds(year, m);
    const items = between(entries, toISO(f), toISO(l));
    return { month: m, expense: sum(expenses(items)), income: sum(incomes(items)) };
  });
  const expense = round2(months.reduce((a, m) => a + m.expense, 0));
  const income = round2(months.reduce((a, m) => a + m.income, 0));
  return { months, expense, income, balance: round2(income - expense) };
}

/** Expense total of a month up to (and including) day `uptoDay` — for fair "same point last month" comparisons */
export function monthTotalUpTo(entries, year, month, uptoDay) {
  const [first] = monthBounds(year, month);
  const last = new Date(year, month, Math.min(uptoDay, daysInMonth(year, month)));
  return sum(expenses(between(entries, toISO(first), toISO(last))));
}

/** Percentage change from prev to cur, or null when there is nothing to compare */
export const percentChange = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

/**
 * Recurring items (rent, bills, salary) create one entry per month on `day`, clamped to the month's length.
 * `r.last` ("YYYY-MM") remembers the last month already handled, so deleting a generated entry
 * does not bring it back. Ids are deterministic (`rec-<id>-<YYYY-MM>`), so two devices running
 * this at the same time write the same document instead of a duplicate.
 * Returns { entries, last: { [recurringId]: "YYYY-MM" } }.
 */
export function dueRecurring(recurring, today) {
  const out = [], last = {};
  const todayISO = toISO(today);
  const curKey = todayISO.slice(0, 7);
  for (const r of recurring) {
    if (r.paused) continue;
    let y, m;
    if (r.last) { [y, m] = r.last.split("-").map(Number); m = m; /* month after last, 0-based = m */ }
    else { const s = fromISO(r.start); y = s.getFullYear(); m = s.getMonth(); }
    let handled = r.last || null;
    for (let guard = 0; guard < 240; guard++) {
      if (m > 11) { m = 0; y++; }
      const key = `${y}-${pad(m + 1)}`;
      if (key > curKey) break;
      const d = toISO(new Date(y, m, Math.min(r.day, daysInMonth(y, m))));
      if (d > todayISO) break; // this month's date hasn't come yet
      if (d >= r.start) out.push({ id: `rec-${r.id}-${key}`, type: r.type, d, a: r.a, c: r.c, n: r.n || "", pm: r.pm || "cash", rec: r.id });
      handled = key;
      m++;
    }
    if (handled && handled !== r.last) last[r.id] = handled;
  }
  return { entries: out, last };
}

/** Most-used (category, amount, note) combos in recent expenses, for one-tap repeat */
export function frequentCombos(entries, today, limit = 4) {
  const since = toISO(addDays(today, -60));
  const counts = new Map();
  for (const e of expenses(entries)) {
    if (e.d < since) continue;
    const k = `${e.c}|${e.a}|${(e.n || "").trim()}|${e.pm || "cash"}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => { const [c, a, n, pm] = k.split("|"); return { c, a: Number(a), n, pm }; });
}

/** CSV with a BOM so Excel opens Sinhala text correctly */
export function toCSV(entries, catName, methodName) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["date", "type", "category", "amount", "payment", "note"].join(",")];
  for (const e of [...entries].sort((a, b) => a.d.localeCompare(b.d))) {
    rows.push([e.d, e.type === "inc" ? "income" : "expense", q(catName(e.c)), e.a, q(methodName(e.pm || "cash")), q(e.n)].join(","));
  }
  return "﻿" + rows.join("\r\n");
}

/**
 * Trends over the last `n` months ending at (endYear, endMonth). The current month is marked `partial`.
 * Insights compare the latest complete month with the average of the months before it.
 */
export function trendSummary(entries, endYear, endMonth, n, today = new Date()) {
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(endYear, endMonth - i, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const [f, l] = monthBounds(y, m);
    const items = between(entries, toISO(f), toISO(l));
    const exp = expenses(items);
    const byCat = {};
    for (const e of exp) byCat[e.c] = round2((byCat[e.c] || 0) + e.a);
    const expense = sum(exp), income = sum(incomes(items));
    months.push({
      y, m, expense, income, balance: round2(income - expense), byCat,
      weekend: sum(exp.filter((e) => isWeekend(fromISO(e.d)))),
      partial: y === today.getFullYear() && m === today.getMonth(),
      future: f > today,
    });
  }
  const done = months.filter((x) => !x.partial && !x.future);
  const withData = done.filter((x) => x.expense > 0 || x.income > 0);
  const avgExpense = withData.length ? round2(withData.reduce((a, x) => a + x.expense, 0) / withData.length) : 0;
  const totalIncome = round2(months.reduce((a, x) => a + x.income, 0));
  const totalExpense = round2(months.reduce((a, x) => a + x.expense, 0));
  const saved = round2(totalIncome - totalExpense);
  const savingsRate = totalIncome > 0 ? Math.round((saved / totalIncome) * 100) : null;

  // categories ranked by total over the period
  const catTotals = {};
  for (const x of months) for (const [c, v] of Object.entries(x.byCat)) catTotals[c] = round2((catTotals[c] || 0) + v);
  const categories = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(([c, total]) => {
    const series = months.map((x) => x.byCat[c] || 0);
    // compare the last complete month with earlier complete months that had any spending at all,
    // so months before someone started using the app don't count as zeros
    const doneSeries = months.map((x, i) => (x.partial || x.future || x.expense === 0 ? null : series[i])).filter((v) => v !== null);
    const last = doneSeries.length ? doneSeries[doneSeries.length - 1] : 0;
    const before = doneSeries.slice(0, -1);
    const beforeAvg = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
    return { c, total, series, last, change: beforeAvg > 0 ? Math.round(((last - beforeAvg) / beforeAvg) * 100) : null };
  });

  let highest = null, lowest = null;
  for (const x of withData) {
    if (!highest || x.expense > highest.expense) highest = x;
    if (!lowest || x.expense < lowest.expense) lowest = x;
  }
  const weekendTotal = round2(months.reduce((a, x) => a + x.weekend, 0));
  return {
    months, avgExpense, totalIncome, totalExpense, saved, savingsRate, categories, highest, lowest,
    weekendShare: totalExpense > 0 ? Math.round((weekendTotal / totalExpense) * 100) : 0,
    monthsWithData: withData.length,
  };
}
