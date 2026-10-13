// Data lives only in this browser (localStorage). Nothing is sent to any server.

const KEY = "viyadam-pota:v2";

export const DEFAULT_CATEGORIES = [
  { id: "food", si: "කෑම", en: "Food", color: "#1F7A63", type: "exp" },
  { id: "transport", si: "ප්‍රවාහනය", en: "Transport", color: "#3D6FB4", type: "exp" },
  { id: "bills", si: "බිල්පත්", en: "Bills & utilities", color: "#B4412F", type: "exp" },
  { id: "shop", si: "සාප්පු", en: "Shopping", color: "#C98A14", type: "exp" },
  { id: "health", si: "සෞඛ්‍යය", en: "Health", color: "#2E9AA8", type: "exp" },
  { id: "edu", si: "අධ්‍යාපනය", en: "Education", color: "#7E57B0", type: "exp" },
  { id: "fun", si: "විනෝදය", en: "Entertainment", color: "#C2648A", type: "exp" },
  { id: "home", si: "නිවස", en: "Home & rent", color: "#6B7F3A", type: "exp" },
  { id: "other", si: "වෙනත්", en: "Other", color: "#7B8A84", type: "exp" },
  { id: "salary", si: "වැටුප", en: "Salary", color: "#2E7D4F", type: "inc" },
  { id: "side", si: "අමතර ආදායම", en: "Side income", color: "#4A9C6D", type: "inc" },
  { id: "gift", si: "තෑගි / වෙනත්", en: "Gifts & other", color: "#8FA35A", type: "inc" },
];

export const METHODS = ["cash", "card", "online"];

export const PALETTE = ["#1F7A63", "#3D6FB4", "#B4412F", "#C98A14", "#2E9AA8", "#7E57B0", "#C2648A", "#6B7F3A", "#D4683A", "#4F5DA8"];

export const emptyData = () => ({
  version: 2,
  entries: [],
  categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  recurring: [],
  budget: { total: 0, byCat: {} },
  settings: { lang: "si", theme: "system", currency: "Rs" },
});

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Validate and normalise anything loaded from storage or an imported backup file */
export function normalise(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== "object") return base;
  const okEntry = (e) => e && typeof e.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.d) && Number.isFinite(+e.a) && +e.a > 0 && typeof e.c === "string";
  const entries = Array.isArray(raw.entries)
    ? raw.entries.filter(okEntry).map((e) => ({
        id: e.id, type: e.type === "inc" ? "inc" : "exp", d: e.d, a: Math.round(+e.a * 100) / 100,
        c: e.c, n: String(e.n || "").slice(0, 120), pm: METHODS.includes(e.pm) ? e.pm : "cash",
        ...(e.rec ? { rec: String(e.rec) } : {}),
        ...(e.by ? { by: String(e.by) } : {}),
      }))
    : [];
  const categories = Array.isArray(raw.categories) && raw.categories.length
    ? raw.categories.filter((c) => c && c.id && (c.si || c.en)).map((c) => ({
        id: String(c.id), si: String(c.si || c.en).slice(0, 30), en: String(c.en || c.si).slice(0, 30),
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#7B8A84", type: c.type === "inc" ? "inc" : "exp",
        ...(c.custom ? { custom: true } : {}),
      }))
    : base.categories;
  // make sure entries never point at a missing category
  const ids = new Set(categories.map((c) => c.id));
  for (const e of entries) if (!ids.has(e.c)) e.c = e.type === "inc" ? "gift" : "other";
  for (const need of ["other", "gift"]) if (!ids.has(need)) categories.push(DEFAULT_CATEGORIES.find((c) => c.id === need));

  const recurring = Array.isArray(raw.recurring)
    ? raw.recurring.filter((r) => r && r.id && Number.isFinite(+r.a) && +r.a > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.start)).map((r) => ({
        id: String(r.id), type: r.type === "inc" ? "inc" : "exp", a: Math.round(+r.a * 100) / 100,
        c: ids.has(r.c) ? r.c : "other", n: String(r.n || "").slice(0, 120), pm: METHODS.includes(r.pm) ? r.pm : "cash",
        day: Math.min(31, Math.max(1, parseInt(r.day, 10) || 1)), start: r.start, paused: !!r.paused,
        ...(/^\d{4}-\d{2}$/.test(r.last) ? { last: r.last } : {}),
      }))
    : [];
  const byCat = {};
  if (raw.budget && raw.budget.byCat && typeof raw.budget.byCat === "object") {
    for (const [k, v] of Object.entries(raw.budget.byCat)) if (ids.has(k) && +v > 0) byCat[k] = +v;
  }
  const s = raw.settings || {};
  return {
    version: 2,
    entries,
    categories,
    recurring,
    budget: { total: +(raw.budget && raw.budget.total) > 0 ? +raw.budget.total : 0, byCat },
    settings: {
      lang: s.lang === "en" ? "en" : "si",
      theme: ["light", "dark", "system"].includes(s.theme) ? s.theme : "system",
      currency: typeof s.currency === "string" && s.currency.trim() ? s.currency.trim().slice(0, 6) : "Rs",
    },
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalise(JSON.parse(raw));
  } catch (e) { /* storage blocked or corrupt: start fresh */ }
  return emptyData();
}

let lastError = null;
export function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    lastError = null;
    return true;
  } catch (e) {
    lastError = e;
    return false;
  }
}
export const saveError = () => lastError;
