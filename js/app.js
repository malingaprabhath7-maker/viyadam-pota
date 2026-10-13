import * as C from "./calc.js";
import { STR, MONTHS, DAYS_SHORT, DAYS_LONG } from "./i18n.js";
import { METHODS, PALETTE, newId, normalise, load as loadLocal, emptyData } from "./store.js";
import { createLocalBackend } from "./backend-local.js";
import { firebaseConfig } from "./firebase-config.js";

/* ============================================================
   Small helpers
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PREFS_KEY = "viyadam-pota:prefs";
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

let lang = prefs.lang === "en" ? "en" : "si";
const t = (k, ...a) => { const v = STR[lang][k] ?? STR.en[k] ?? k; return typeof v === "function" ? v(...a) : v; };

let cloud = null;          // cloud module when Firebase is configured
let backend = null;        // current data backend (local or cloud)
let data = emptyData();
let syncStatus = { ok: true, offline: false };
let view = "today";
const off = { week: 0, month: 0, year: 0 };
const form = { type: "exp", cat: null, method: "cash", editing: null };
let recurringRanFor = null;
let installEvent = null;

const cur = () => data.settings.currency || "Rs";
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString("en-LK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = (n) => `${cur()} ${fmt(n)}`;
const todayISO = () => C.toISO(new Date());
const catById = (id) => data.categories.find((c) => c.id === id) || data.categories.find((c) => c.id === "other") || { id, si: id, en: id, color: "#7B8A84" };
const catName = (id) => catById(id)[lang] || catById(id).en;
const methodName = (m) => t("m_" + (m || "cash"));
const monthLabel = (y, m) => (lang === "si" ? `${y} ${MONTHS.si[m]}` : `${MONTHS.en[m]} ${y}`);
const shortDate = (iso) => { const d = C.fromISO(iso); return lang === "si" ? `${MONTHS.si[d.getMonth()]} ${d.getDate()}` : `${d.getDate()} ${MONTHS.en[d.getMonth()].slice(0, 3)}`; };
const longDate = (iso) => {
  const d = C.fromISO(iso);
  return lang === "si" ? `${MONTHS.si[d.getMonth()]} ${d.getDate()}, ${DAYS_LONG.si[C.weekdayIndex(d)]}` : `${DAYS_LONG.en[C.weekdayIndex(d)]}, ${d.getDate()} ${MONTHS.en[d.getMonth()]}`;
};
const dayLabel = (iso) => (iso === todayISO() ? t("today") : iso === C.toISO(C.addDays(new Date(), -1)) ? t("yesterday") : longDate(iso));
const deltaHTML = (p, fn) => (p === null ? "" : `<span class="delta ${p > 0 ? "up" : p < 0 ? "down" : ""}">${esc(fn(p))}</span>`);

const ICON = {
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 01-4 4H4"/></svg>',
};

/* ============================================================
   Toast & dialog
   ============================================================ */
let toastTimer;
function toast(msg, actionLabel, action) {
  $("#toast-msg").textContent = msg;
  const b = $("#toast-btn");
  b.hidden = !actionLabel;
  b.textContent = actionLabel || "";
  b.onclick = () => { $("#toast").hidden = true; action && action(); };
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), actionLabel ? 6000 : 2600);
}

/** In-page confirm. opts.password adds a password field; resolves { ok, value } */
function ask(message, okLabel, opts = {}) {
  const dlg = $("#dlg");
  $("#dlg-msg").textContent = message;
  $("#dlg-ok").textContent = okLabel;
  $("#dlg-ok").className = "btn " + (opts.danger === false ? "" : "danger");
  $("#dlg-extra").innerHTML = opts.password
    ? `<div class="field"><label for="dlg-pw">${esc(t("password"))}</label><input id="dlg-pw" type="password" autocomplete="current-password"></div>`
    : opts.text !== undefined ? `<div class="field"><input id="dlg-pw" maxlength="40" value="${esc(opts.text)}"></div>` : "";
  return new Promise((resolve) => {
    dlg.onclose = () => resolve({ ok: dlg.returnValue === "ok", value: $("#dlg-pw") ? $("#dlg-pw").value : null });
    dlg.returnValue = "";
    dlg.showModal();
    if ($("#dlg-pw")) $("#dlg-pw").focus();
  });
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ============================================================
   Theme & language
   ============================================================ */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" || theme === "dark" ? theme : "system";
  const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]').content = dark ? "#0F1715" : "#16302B";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(data.settings.theme));

function applyStaticText() {
  document.documentElement.lang = lang;
  $$("[data-t]").forEach((el) => { const v = STR[lang][el.dataset.t]; if (typeof v === "string") el.textContent = v; });
  $$("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.lang === lang));
  $$("[data-cur]").forEach((el) => (el.textContent = cur()));
  $("#e-note").placeholder = t("notePh");
  $("#h-q").placeholder = t("searchPh");
  $("#auth-hero").textContent = t("authHero");
  $("#auth-points").innerHTML = STR[lang].authPoints.map((p) => `<li>${esc(p)}</li>`).join("");
  $("#e-submit").textContent = form.editing ? t("save") : t("add");
}

function setLang(l) {
  lang = l; prefs.lang = l; savePrefs();
  if (backend && data.settings.lang !== l) backend.putMeta({ settings: { ...data.settings, lang: l } });
  applyStaticText(); render();
}

/* ============================================================
   Boot: decide between account (Firebase) and guest mode
   ============================================================ */
async function boot() {
  applyTheme(prefs.theme || "system");
  applyStaticText();
  wireStatic();
  registerSW();
  scheduleReminder();

  if (!firebaseConfig) { startGuest(); return; }
  try {
    cloud = await import("./cloud.js");
    await cloud.initCloud(firebaseConfig);
  } catch (e) {
    console.error("Firebase failed to load, falling back to guest mode", e);
    cloud = null; startGuest(); return;
  }
  cloud.onUser((user) => {
    if (user) startAccount(user);
    else if (prefs.mode === "guest") startGuest();
    else showAuth("login");
  });
}

function stopBackend() { if (backend) backend.stop(); backend = null; recurringRanFor = null; }

function startGuest() {
  stopBackend();
  prefs.mode = "guest"; savePrefs();
  backend = createLocalBackend();
  backend.start(onData);
  showApp();
}

let myBooks = [], booksUnsub = null, booksFor = null;
const activeBookKey = (uid) => (prefs.activeBook && prefs.activeBook[uid]) || null;

async function startAccount(user, bookId = activeBookKey(user.uid)) {
  stopBackend();
  prefs.mode = "account"; savePrefs();
  if (booksFor !== user.uid) {
    if (booksUnsub) booksUnsub();
    booksFor = user.uid; myBooks = [];
    booksUnsub = cloud.watchMyBooks(user.uid, (list) => { myBooks = list; renderHeader(); if (view === "settings") render(); });
  }
  backend = cloud.createCloudBackend(user, bookId, {
    onLost: () => { toast(t("bookLost")); setActiveBook(user, null); },
  });
  let first = true;
  backend.start((d, st) => {
    onData(d, st);
    if (first) { first = false; if (!bookId) offerGuestMove(); }
  });
  showApp();
}
function setActiveBook(user, bookId) {
  prefs.activeBook = { ...(prefs.activeBook || {}), [user.uid]: bookId }; savePrefs();
  resetEntryForm?.();
  startAccount(user, bookId);
}
const memberName = (uid) => {
  if (!data.book) return "";
  if (uid === backend?.user?.uid) return t("you");
  return ((data.book.memberNames || {})[uid] || "").split(/\s+/)[0];
};

function onData(d, status) {
  data = d;
  syncStatus = status || { ok: true };
  if (status && status.ok === false && backend && backend.kind === "local") toast(t("saveFail"));
  if (data.settings.lang && data.settings.lang !== lang && backend.kind === "cloud" && !prefs.langTouched) {
    lang = data.settings.lang; prefs.lang = lang; savePrefs();
  }
  if (data.settings.theme !== prefs.theme) { prefs.theme = data.settings.theme; savePrefs(); }
  applyTheme(data.settings.theme);
  applyStaticText();
  runRecurring();
  render();
}

function runRecurring() {
  const key = `${backend.kind}|${todayISO()}`;
  if (recurringRanFor === key || !data.recurring.length) return;
  recurringRanFor = key;
  const { entries, last } = C.dueRecurring(data.recurring, new Date());
  if (!Object.keys(last).length) return;
  const have = new Set(data.entries.map((e) => e.id));
  const fresh = entries.filter((e) => !have.has(e.id));
  if (fresh.length) backend.putEntries(fresh);
  backend.putMeta({ recurring: data.recurring.map((r) => (last[r.id] ? { ...r, last: last[r.id] } : r)) });
  if (fresh.length) toast(t("recurringAdded", fresh.length));
}

async function offerGuestMove() {
  const local = loadLocal();
  if (!local.entries.length) return;
  const r = await ask(t("moveGuest", local.entries.length), t("move"), { danger: false });
  if (!r.ok) return;
  backend.putEntries(local.entries);
  const known = new Set(data.categories.map((c) => c.id));
  const extraCats = local.categories.filter((c) => !known.has(c.id));
  const extraRec = local.recurring.filter((r) => !data.recurring.some((x) => x.id === r.id));
  if (extraCats.length || extraRec.length) backend.putMeta({ categories: [...data.categories, ...extraCats], recurring: [...data.recurring, ...extraRec] });
  createLocalBackend().clear();
  toast(t("moved", local.entries.length));
}

function showAuth(tab) {
  $("#boot").hidden = true; $("#app").hidden = true; $("#auth").hidden = false;
  authTab(tab || "login");
}
function showApp() {
  $("#boot").hidden = true; $("#auth").hidden = true; $("#app").hidden = false;
  go(view);
}

/* ============================================================
   Auth screen
   ============================================================ */
function authTab(tab) {
  ["login", "signup", "forgot"].forEach((k) => ($(`#f-${k}`).hidden = k !== tab));
  $("#tab-login").setAttribute("aria-selected", tab === "login");
  $("#tab-signup").setAttribute("aria-selected", tab === "signup");
  $(".auth .seg").hidden = tab === "forgot";
  $$(".form-err, .form-ok", $("#auth")).forEach((e) => (e.hidden = true));
}
const showErr = (id, msg) => { const e = $(id); e.textContent = msg; e.hidden = !msg; };
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
function pwScore(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/\d/.test(pw) && /[a-zA-Z]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw) || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) s++;
  return s;
}
async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

function wireAuth() {
  $$("[data-authtab]").forEach((b) => b.addEventListener("click", () => authTab(b.dataset.authtab)));
  $$("[data-eye]").forEach((b) => b.addEventListener("click", () => { const i = $("#" + b.dataset.eye); i.type = i.type === "password" ? "text" : "password"; b.classList.toggle("on", i.type === "text"); }));
  $("#su-pw").addEventListener("input", (e) => {
    const s = pwScore(e.target.value);
    $("#su-meter").dataset.s = e.target.value ? s : "";
    $("#su-pwhint").textContent = e.target.value ? (s <= 1 ? t("pwWeak") : s <= 2 ? t("pwOk") : t("pwStrong")) : "";
  });
  $("#f-login").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("#li-email").value.trim(), pw = $("#li-pw").value;
    if (!validEmail(email)) return showErr("#li-err", t("emailBad"));
    if (!pw) return showErr("#li-err", t("e_auth_invalid"));
    showErr("#li-err", "");
    busy(e.submitter || $("#f-login .btn"), async () => {
      try { await cloud.signIn(email, pw); $("#li-pw").value = ""; } catch (err) { showErr("#li-err", t(cloud.authErrorKey(err))); }
    });
  });
  $("#f-signup").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#su-name").value.trim(), email = $("#su-email").value.trim(), pw = $("#su-pw").value, pw2 = $("#su-pw2").value;
    if (!name) return showErr("#su-err", t("nameReq"));
    if (!validEmail(email)) return showErr("#su-err", t("emailBad"));
    if (pw.length < 8) return showErr("#su-err", t("pwShort"));
    if (pw !== pw2) return showErr("#su-err", t("pwMismatch"));
    showErr("#su-err", "");
    busy(e.submitter || $("#f-signup .btn"), async () => {
      try { await cloud.signUp(name, email, pw, lang); $("#su-pw").value = $("#su-pw2").value = ""; } catch (err) { showErr("#su-err", t(cloud.authErrorKey(err))); }
    });
  });
  $("#f-forgot").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("#fg-email").value.trim();
    if (!validEmail(email)) return showErr("#fg-err", t("emailBad"));
    showErr("#fg-err", "");
    busy(e.submitter || $("#f-forgot .btn"), async () => {
      try { await cloud.resetPassword(email, lang); const ok = $("#fg-ok"); ok.textContent = t("resetSent"); ok.hidden = false; }
      catch (err) { const k = cloud.authErrorKey(err); if (k === "e_auth_invalid") { const ok = $("#fg-ok"); ok.textContent = t("resetSent"); ok.hidden = false; } else showErr("#fg-err", t(k)); }
    });
  });
}

/* ============================================================
   Navigation
   ============================================================ */
function go(v) {
  view = v;
  ["today", "week", "month", "history", "settings"].forEach((k) => ($(`#v-${k}`).hidden = k !== v));
  $$("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === v));
  $$(".nav [data-nav]").forEach((b) => b.setAttribute("aria-current", b.dataset.nav === v ? "page" : "false"));
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  if ($("#app").hidden) return;
  renderHeader();
  renderBanner();
  if (view === "today") renderToday();
  else if (view === "week") renderWeek();
  else if (view === "month") renderMonth();
  else if (view === "history") renderHistory();
  else if (view === "settings") {
    // don't wipe a form the person is typing into when a sync update arrives
    const a = document.activeElement;
    if (!(a && $("#v-settings").contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) renderSettings();
  }
}

/* ============================================================
   Header & banners
   ============================================================ */
function avatarHTML(size) {
  const p = data.profile || {};
  if (p.photo) return `<img src="${esc(p.photo)}" alt="" width="${size}" height="${size}">`;
  const name = (p.name || "").trim();
  const init = name ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "";
  return init ? `<span>${esc(init)}</span>` : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
}
function renderHeader() {
  $("#top-avatar").innerHTML = avatarHTML(32);
  let who;
  if (backend && backend.kind === "cloud") {
    const name = (data.profile && data.profile.name) || backend.user.email;
    who = `${name} · ${syncStatus.offline ? t("offline") : t("synced")}`;
  } else who = t("guestMode");
  $("#who").textContent = who;
  const bar = $("#bookbar");
  if (!(backend && backend.kind === "cloud")) { bar.hidden = true; return; }
  const cur = backend.bookId || "";
  bar.hidden = false;
  bar.innerHTML = `<label for="book-sel"><svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h11"/></svg><span class="sr">${esc(t("book"))}</span></label>
    <select id="book-sel">
      <option value="">${esc(t("myBook"))}</option>
      ${myBooks.map((b) => `<option value="${esc(b.id)}" ${b.id === cur ? "selected" : ""}>👨‍👩‍👧 ${esc(b.name)} (${(b.members || []).length})</option>`).join("")}
      <option value="__manage">＋ ${esc(t("bookManage"))}</option>
    </select>
    ${data.book ? `<span class="members">${(data.book.members || []).map((u) => `<i title="${esc((data.book.memberNames || {})[u] || "")}">${esc((((data.book.memberNames || {})[u] || "?")[0] || "?").toUpperCase())}</i>`).join("")}</span>` : ""}`;
  $("#book-sel").value = cur;
}
let guestBannerClosed = false;
function renderBanner() {
  const msgs = [];
  const now = new Date();
  const m = C.monthSummary(data.entries, now.getFullYear(), now.getMonth(), now);
  const b = data.budget.total;
  if (view === "today" && b) {
    if (m.total > b) msgs.push({ kind: "bad", text: t("budgetOver") });
    else if (m.total >= b * 0.8) msgs.push({ kind: "warn", text: t("budgetWarn", Math.round((m.total / b) * 100)) });
  }
  if (view === "today") {
    for (const [c, v] of m.byCategory) { const lim = data.budget.byCat[c]; if (lim && v > lim) msgs.push({ kind: "bad", text: t("catOver", catName(c)) }); }
  }
  if (view === "today" && reminderDue() && !loggedToday()) msgs.push({ kind: "info", text: t("remNudge") });
  if (cloud && backend && backend.kind === "local" && !guestBannerClosed && view === "today") {
    msgs.push({ kind: "info", text: t("guestBanner"), action: `<button class="btn sm" data-action="to-signup">${esc(t("createAccount"))}</button><button class="iconbtn" data-action="close-guest" aria-label="Close">×</button>` });
  }
  $("#banner").innerHTML = msgs.map((x) => `<div class="banner ${x.kind}"><span>${esc(x.text)}</span>${x.action || ""}</div>`).join("");
}

/* ============================================================
   Entry list rows
   ============================================================ */
function entryRow(e, { showDate = false } = {}) {
  const c = catById(e.c);
  const sub = [e.n, showDate ? shortDate(e.d) : "", methodName(e.pm), data.book && e.by ? memberName(e.by) : ""].filter(Boolean).map(esc).join(" · ");
  return `<div class="item${e.type === "inc" ? " inc" : ""}">
    <i class="sw" style="background:${esc(c.color)}"></i>
    <div class="txt"><b>${esc(catName(e.c))}${e.rec ? ` <span class="rec" title="${esc(t("sRecurring"))}">${ICON.repeat}</span>` : ""}</b><span>${sub}</span></div>
    <span class="amt">${e.type === "inc" ? "+" : ""}${fmt(e.a)}</span>
    <span class="acts"><button class="iconbtn" data-action="edit" data-id="${esc(e.id)}" aria-label="${esc(t("edit"))}">${ICON.edit}</button><button class="iconbtn" data-action="delete" data-id="${esc(e.id)}" aria-label="${esc(t("del"))}">${ICON.del}</button></span>
  </div>`;
}
const listHTML = (items, opts) => (items.length ? `<div class="list">${items.map((e) => entryRow(e, opts)).join("")}</div>` : "");

function catBars(pairs, total, budgets) {
  if (!pairs.length) return `<p class="muted">${esc(t("emptyPeriod"))}</p>`;
  const max = pairs[0][1];
  return `<div class="catbars">${pairs.map(([id, v]) => {
    const c = catById(id); const lim = budgets && budgets[id];
    return `<div class="catrow"><span class="nm"><i style="background:${esc(c.color)}"></i><span>${esc(catName(id))}</span></span>
      <span class="tr"><span style="width:${((v / max) * 100).toFixed(1)}%;background:${esc(c.color)}"></span></span>
      <span class="vv">${fmt(v)}<small>${total ? Math.round((v / total) * 100) : 0}%</small></span>
      ${lim ? `<span class="lim ${v > lim ? "over" : ""}">${esc(v > lim ? t("over", money(v - lim)) : t("left", money(lim - v)))}</span>` : ""}</div>`;
  }).join("")}</div>`;
}

/* ============================================================
   TODAY
   ============================================================ */
function renderToday() {
  const now = new Date(), ti = todayISO();
  $("#today-date").textContent = `${t("today")} · ${longDate(ti)}`;
  const todays = data.entries.filter((e) => e.d === ti);
  $("#today-total").textContent = fmt(C.sum(C.expenses(todays)));
  const wk = C.weekSummary(data.entries, C.startOfWeek(now));
  const mo = C.monthSummary(data.entries, now.getFullYear(), now.getMonth(), now);
  const b = data.budget.total;
  $("#today-mini").innerHTML = `
    <span><small>${esc(t("thisWeek"))}</small><b>${esc(money(wk.total))}</b></span>
    <span class="we"><small>${esc(t("weekend"))}</small><b>${esc(money(wk.weekend))}</b></span>
    <span><small>${esc(t("thisMonth"))}</small><b>${esc(money(mo.total))}</b></span>
    ${b ? `<span><small>${esc(t("budget"))}</small><b class="${mo.total > b ? "neg" : ""}">${esc(mo.total > b ? t("over", money(mo.total - b)) : t("left", money(b - mo.total)))}</b></span>` : ""}`;

  renderBalance(mo, now);
  renderEntryForm();

  // quick repeat buttons
  const combos = C.frequentCombos(data.entries, now);
  $("#quick").innerHTML = combos.length
    ? `<div class="quick"><span class="eyebrow">${esc(t("quickAdd"))}</span><div class="chips">${combos.map((q, i) =>
        `<button type="button" class="chip quick-chip" data-action="quick" data-i="${i}"><i style="background:${esc(catById(q.c).color)}"></i>${esc(q.n || catName(q.c))} <b>${fmt(q.a)}</b></button>`).join("")}</div></div>` : "";
  $("#quick").combos = combos;

  const tl = todays.slice().sort((a, b) => b.id.localeCompare(a.id));
  $("#today-list").innerHTML = tl.length ? listHTML(tl) : `<div class="empty">${esc(t("emptyToday"))}</div>`;

  const from = C.toISO(C.addDays(now, -7)), to = C.toISO(C.addDays(now, -1));
  const rec = C.between(data.entries, from, to);
  const days = [...new Set(rec.map((e) => e.d))].sort().reverse();
  $("#recent-list").innerHTML = days.length ? days.map((d) => {
    const items = rec.filter((e) => e.d === d).sort((a, b) => b.a - a.a);
    return `<div class="day"><div class="dayhead"><span>${esc(dayLabel(d))}</span><span class="num">${fmt(C.sum(C.expenses(items)))}</span></div>${listHTML(items)}</div>`;
  }).join("") : `<div class="empty">${esc(t("emptyRecent"))}</div>`;

  // note suggestions from past notes
  const notes = [...new Set(data.entries.slice(-300).map((e) => e.n).filter(Boolean))].slice(-40);
  $("#note-suggest").innerHTML = notes.map((n) => `<option value="${esc(n)}">`).join("");
}

/* Money left from this month's income, shrinking as expenses are added */
function renderBalance(mo, now) {
  const el = $("#today-balance");
  if (!mo.income) {
    el.innerHTML = `<div class="card balance empty-bal"><div><b>${esc(t("balTitle"))}</b><p class="muted">${esc(t("noIncome"))}</p></div>
      <button type="button" class="btn ghost sm" data-action="add-income">+ ${esc(t("addIncome"))}</button></div>`;
    return;
  }
  const left = C.round2(mo.income - mo.total);
  const usedPct = Math.min((mo.total / mo.income) * 100, 100);
  const daysLeft = mo.days - now.getDate() + 1;
  const perDay = left > 0 ? left / daysLeft : 0;
  const state = left < 0 ? "over" : usedPct >= 80 ? "warn" : "";
  el.innerHTML = `<div class="card balance ${state}">
    <div class="row-between"><span class="eyebrow">${esc(t("balTitle"))}</span><span class="muted">${esc(t("balOf", money(mo.income)))}</span></div>
    <div class="bal-amt ${left < 0 ? "neg" : ""}"><span class="cur">${esc(cur())}</span>${fmt(left)}</div>
    <div class="bal-track" role="img" aria-label="${Math.round(100 - usedPct)}%"><span style="width:${(100 - usedPct).toFixed(1)}%"></span></div>
    <div class="row-between bal-foot"><span>${esc(t("balSpent", money(mo.total), Math.round((mo.total / mo.income) * 100)))}</span>
      <span>${esc(left > 0 ? t("balPerDay", money(Math.floor(perDay)), daysLeft) : t("balOver"))}</span></div>
  </div>`;
}

function renderEntryForm() {
  $$(".type-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.type === form.type));
  $("#f-entry").classList.toggle("is-inc", form.type === "inc");
  const cats = data.categories.filter((c) => c.type === form.type);
  if (form.cat && !cats.some((c) => c.id === form.cat)) form.cat = null;
  $("#e-cats").innerHTML = cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c.id)}" aria-pressed="${form.cat === c.id}"><i style="background:${esc(c.color)}"></i>${esc(c[lang] || c.en)}</button>`).join("");
  $("#e-methods").innerHTML = METHODS.map((m) => `<button type="button" data-method="${m}" aria-pressed="${form.method === m}">${esc(methodName(m))}</button>`).join("");
  if (!$("#e-date").value) $("#e-date").value = todayISO();
  $("#e-submit").textContent = form.editing ? t("save") : t("add");
  $("#e-cancel").hidden = !form.editing;
}

function resetEntryForm() {
  form.editing = null; form.cat = null; form.method = "cash";
  $("#e-amount").value = ""; $("#e-note").value = ""; $("#e-date").value = todayISO();
  $("#e-err").hidden = true;
  const st = $("#scan-status"); if (st) st.hidden = true;
  renderEntryForm();
}

function submitEntry(e) {
  e.preventDefault();
  const a = C.parseAmount($("#e-amount").value);
  if (!(a > 0)) { showErr("#e-err", t("errAmount")); $("#e-amount").focus(); return; }
  if (!form.cat) { showErr("#e-err", t("errCat")); return; }
  showErr("#e-err", "");
  const old = form.editing ? data.entries.find((x) => x.id === form.editing) : null;
  const entry = { id: form.editing || newId(), type: form.type, d: $("#e-date").value || todayISO(), a, c: form.cat, n: $("#e-note").value.trim().slice(0, 120), pm: form.method };
  if (old && old.rec) entry.rec = old.rec;
  backend.putEntries([entry]);
  toast(`${t(form.editing ? "updated" : "added")} · ${money(a)}`);
  const keepType = form.type;
  resetEntryForm(); form.type = keepType; renderEntryForm();
  $("#e-amount").focus();
}

function startEdit(id) {
  const e = data.entries.find((x) => x.id === id);
  if (!e) return;
  if (view !== "today") go("today");
  Object.assign(form, { editing: id, type: e.type, cat: e.c, method: e.pm || "cash" });
  $("#e-amount").value = e.a; $("#e-note").value = e.n || ""; $("#e-date").value = e.d;
  renderEntryForm();
  $("#f-entry").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#e-amount").focus({ preventScroll: true });
}

function deleteEntry(id) {
  const e = data.entries.find((x) => x.id === id);
  if (!e) return;
  backend.deleteEntry(id);
  if (form.editing === id) resetEntryForm();
  toast(`${t("deleted")} · ${money(e.a)}`, t("undo"), () => backend.putEntries([e]));
}

/* ============================================================
   WEEK
   ============================================================ */
function pager(kind, title) {
  return `<div class="pager"><button type="button" class="iconbtn lg" data-action="prev-${kind}" aria-label="Previous">${ICON.prev}</button><h2>${esc(title)}</h2><button type="button" class="iconbtn lg" data-action="next-${kind}" aria-label="Next">${ICON.next}</button></div>`;
}
function renderWeek() {
  const mon = C.addDays(C.startOfWeek(new Date()), off.week * 7);
  const w = C.weekSummary(data.entries, mon);
  const prevW = C.weekSummary(data.entries, C.addDays(mon, -7));
  const upto = off.week === 0 ? C.weekdayIndex(new Date()) : 6;
  const prevTotal = C.round2(prevW.perDay.slice(0, upto + 1).reduce((a, b) => a + b, 0));
  const range = `${shortDate(w.days[0])} – ${shortDate(w.days[6])}`;
  const max = Math.max(...w.perDay, 1);
  const ti = todayISO();
  const byCat = C.groupTotals(w.entries, (e) => e.c);
  const weItems = w.entries.filter((e) => C.isWeekend(C.fromISO(e.d))).sort((a, b) => b.d.localeCompare(a.d) || b.a - a.a);
  $("#v-week").innerHTML = `
    ${pager("week", off.week === 0 ? `${t("thisWeek")} · ${range}` : range)}
    <div class="hero"><span class="eyebrow">${esc(t("weekTotal"))}</span>
      <div class="big"><span class="cur">${esc(cur())}</span>${fmt(w.total)}</div>${deltaHTML(C.percentChange(w.total, prevTotal), t.bind(null, off.week === 0 ? "vsWeekSoFar" : "vsWeek"))}</div>
    <div class="cols">
      <div class="card stack">
        <div class="bars" role="img" aria-label="${esc(t("perDay"))}">${w.perDay.map((v, i) => `
          <div class="bar${i > 4 ? " we" : ""}${w.days[i] === ti ? " now" : ""}"><span class="v">${v ? fmt(Math.round(v)) : ""}</span><span class="col" style="height:${((v / max) * 100).toFixed(1)}%"></span><span class="lb">${DAYS_SHORT[lang][i]}</span></div>`).join("")}</div>
        <div class="legend"><span><i class="k-wd"></i>${esc(t("weekdays"))}</span><span><i class="k-we"></i>${esc(t("weekendFull"))}</span></div>
      </div>
      <div class="stack">
        <div class="split"><div class="stat"><small>${esc(t("weekdays"))}</small><b>${esc(money(w.weekday))}</b></div><div class="stat we"><small>${esc(t("weekend"))}</small><b>${esc(money(w.weekend))}</b></div></div>
        <div class="card stack"><h3>${esc(t("byCategory"))}</h3>${catBars(byCat, w.total)}</div>
      </div>
    </div>
    <div class="stack"><h2>${esc(t("weekendFull"))}</h2>${weItems.length ? listHTML(weItems, { showDate: true }) : `<div class="empty">${esc(t("emptyPeriod"))}</div>`}</div>`;
}

/* ============================================================
   MONTH (+ year)
   ============================================================ */
const isCurrentMonth = (y, m) => { const n = new Date(); return n.getFullYear() === y && n.getMonth() === m; };
function monthYM(offset) { const n = new Date(); const d = new Date(n.getFullYear(), n.getMonth() + offset, 1); return [d.getFullYear(), d.getMonth()]; }

let monthMode = "month", trendN = 6;
const modeSeg = () => `<div class="seg mode-seg" role="group">
  <button type="button" data-action="mode-month" aria-pressed="${monthMode === "month"}">${esc(t("navMonth"))}</button>
  <button type="button" data-action="mode-trends" aria-pressed="${monthMode === "trends"}">${esc(t("trends"))}</button></div>`;

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}
const shortMoney = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));
const monthShort = (m) => MONTHS[lang][m].slice(0, lang === "si" ? 4 : 3);

function trendBarsSVG(tr, width = 640) {
  // drawn at the container's real pixel width so labels stay a readable size on phones and laptops
  const W = Math.max(280, Math.round(width)), H = 240, L = 42, R = 6, T = 16, B = 34;
  const n = tr.months.length;
  const max = niceMax(Math.max(...tr.months.map((x) => Math.max(x.expense, x.income)), 1));
  const ticks = [0, max / 2, max];
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const gw = (W - L - R) / n, bw = Math.min(22, gw * 0.32), gap = 2;
  const avgY = y(tr.avgExpense);
  let out = `<svg viewBox="0 0 ${W} ${H}" class="tchart" role="img" aria-label="${esc(t("trendChart"))}">`;
  for (const v of ticks) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${shortMoney(v)}</text>`;
  tr.months.forEach((x, i) => {
    const cx = L + gw * i + gw / 2;
    const bar = (v, cls, xpos) => { const top = y(v), h = Math.max(y(0) - top, v > 0 ? 2 : 0); return h ? `<path d="M${xpos},${y(0)} v${-(h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} z" class="${cls}"/>` : ""; };
    out += `<g class="tgrp${x.partial ? " partial" : ""}"><title>${esc(monthLabel(x.y, x.m))}${x.partial ? " (" + t("soFar") + ")" : ""}
${t("expense")}: ${money(x.expense)}
${t("income")}: ${money(x.income)}
${t("balance")}: ${money(x.balance)}</title>
      <rect x="${cx - gw / 2}" y="${T}" width="${gw}" height="${H - T - B}" class="hit"/>
      ${bar(x.income, "b-inc", cx + gap / 2)}${bar(x.expense, "b-exp", cx - bw - gap / 2)}
      <text x="${cx}" y="${H - B + 16}" class="ax" text-anchor="middle">${esc(monthShort(x.m))}</text>
      ${x.partial ? `<text x="${cx}" y="${H - B + 29}" class="ax small" text-anchor="middle">${esc(t("soFar"))}</text>` : ""}</g>`;
  });
  if (tr.avgExpense > 0) out += `<line x1="${L}" x2="${W - R}" y1="${avgY}" y2="${avgY}" class="avg"/>`;
  out += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="base"/></svg>`;
  return out;
}

function sparkSVG(series, color, partialLast) {
  const W = 120, H = 30, P = 4, max = Math.max(...series, 1), n = series.length;
  const pts = series.map((v, i) => [P + (n === 1 ? 0 : (i * (W - 2 * P)) / (n - 1)), H - P - (v / max) * (H - 2 * P)]);
  const solid = partialLast ? pts.slice(0, -1) : pts;
  const last = solid[solid.length - 1] || pts[0];
  let s = `<svg viewBox="0 0 ${W} ${H}" class="spk" aria-hidden="true"><polyline points="${solid.map((p) => p.join(",")).join(" ")}" style="stroke:${color}"/>`;
  if (partialLast && pts.length > 1) s += `<polyline points="${pts.slice(-2).map((p) => p.join(",")).join(" ")}" class="dash" style="stroke:${color}"/>`;
  return s + `<circle cx="${last[0]}" cy="${last[1]}" r="3.5" style="fill:${color}"/></svg>`;
}

function renderTrends() {
  const now = new Date();
  const tr = C.trendSummary(data.entries, now.getFullYear(), now.getMonth(), trendN, now);
  const insights = [];
  if (tr.highest && tr.monthsWithData > 1) insights.push(t("insHighest", monthLabel(tr.highest.y, tr.highest.m), money(tr.highest.expense)));
  const ups = tr.categories.filter((c) => c.change !== null && c.change >= 15 && c.last > 0).sort((a, b) => b.change - a.change);
  const downs = tr.categories.filter((c) => c.change !== null && c.change <= -15).sort((a, b) => a.change - b.change);
  if (ups[0]) insights.push(t("insUp", catName(ups[0].c), ups[0].change));
  if (downs[0]) insights.push(t("insDown", catName(downs[0].c), -downs[0].change));
  if (tr.weekendShare) insights.push(t("insWeekend", tr.weekendShare));
  if (tr.savingsRate !== null) insights.push(tr.savingsRate >= 0 ? t("insSaved", tr.savingsRate) : t("insOverspent"));

  $("#v-month").innerHTML = `
    ${modeSeg()}
    <div class="row-between"><h2>${esc(t("trendsTitle", trendN))}</h2>
      <div class="seg compact" role="group">${[3, 6, 12].map((k) => `<button type="button" data-action="trend-n" data-n="${k}" aria-pressed="${trendN === k}">${esc(t("nMonths", k))}</button>`).join("")}</div></div>
    ${tr.monthsWithData === 0 && !tr.months.some((x) => x.expense) ? `<div class="empty">${esc(t("trendsEmpty"))}</div>` : `
    <div class="stats">
      <div class="stat"><small>${esc(t("avgMonthly"))}</small><b>${esc(money(tr.avgExpense))}</b></div>
      <div class="stat"><small>${esc(t("totalSpent"))}</small><b>${esc(money(tr.totalExpense))}</b></div>
      <div class="stat"><small>${esc(t("totalIncome"))}</small><b>${esc(money(tr.totalIncome))}</b></div>
      <div class="stat"><small>${esc(t("savedPeriod"))}</small><b class="${tr.saved < 0 ? "neg" : "pos"}">${esc(money(tr.saved))}${tr.savingsRate !== null ? ` <em>${tr.savingsRate}%</em>` : ""}</b></div>
    </div>
    <div class="cols">
      <div class="card stack">
        <h3>${esc(t("spentVsIncome"))}</h3>
        <div class="chart-wrap" id="trend-chart"></div>
        <div class="legend"><span><i class="k-exp"></i>${esc(t("expense"))}</span><span><i class="k-inc"></i>${esc(t("income"))}</span><span><i class="k-avg"></i>${esc(t("avgLine"))}</span></div>
        <details class="tbl-details"><summary>${esc(t("showTable"))}</summary>
          <table class="tbl"><thead><tr><th>${esc(t("navMonth"))}</th><th class="r">${esc(t("expense"))}</th><th class="r">${esc(t("income"))}</th><th class="r">${esc(t("balance"))}</th></tr></thead>
          <tbody>${tr.months.slice().reverse().map((x) => `<tr><td>${esc(monthLabel(x.y, x.m))}${x.partial ? ` <small class="muted">(${esc(t("soFar"))})</small>` : ""}</td><td class="r num">${fmt(x.expense)}</td><td class="r num">${fmt(x.income)}</td><td class="r num ${x.balance < 0 ? "neg" : ""}">${fmt(x.balance)}</td></tr>`).join("")}</tbody></table>
        </details>
      </div>
      <div class="stack">
        ${insights.length ? `<div class="card stack insights"><h3>${esc(t("insights"))}</h3><ul>${insights.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        <div class="card stack"><h3>${esc(t("catTrends"))}</h3>
          <div class="ctrend">${tr.categories.slice(0, 8).map((c) => `<div class="ctrow">
            <span class="nm"><i style="background:${esc(catById(c.c).color)}"></i><span>${esc(catName(c.c))}</span></span>
            ${sparkSVG(c.series, esc(catById(c.c).color), tr.months[tr.months.length - 1].partial)}
            <span class="vv">${fmt(c.total)}${c.change !== null && c.change !== 0 ? `<small class="${c.change > 0 ? "up" : "down"}">${c.change > 0 ? "▲" : "▼"} ${Math.abs(c.change)}%</small>` : ""}</span></div>`).join("")}</div>
          <p class="tiny muted">${esc(t("catTrendHelp"))}</p>
        </div>
      </div>
    </div>`}`;
  const box = $("#trend-chart");
  if (box) box.innerHTML = trendBarsSVG(tr, box.clientWidth || 640);
}
let resizeT;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (view === "month" && monthMode === "trends") renderTrends(); }, 200); });

function renderMonth() {
  if (monthMode === "trends") return renderTrends();
  const now = new Date();
  const [y, m] = monthYM(off.month);
  const s = C.monthSummary(data.entries, y, m, now);
  const [py, pm] = monthYM(off.month - 1);
  const prevTotal = isCurrentMonth(y, m) ? C.monthTotalUpTo(data.entries, py, pm, now.getDate()) : C.monthSummary(data.entries, py, pm, now).total;
  const b = data.budget.total;
  const isCur = off.month === 0;
  const pct = b ? Math.min((s.total / b) * 100, 100) : 0;
  const max = Math.max(...s.perDay, 1);
  const year = C.yearSummary(data.entries, y);
  const ymax = Math.max(...year.months.map((x) => Math.max(x.expense, x.income)), 1);
  const big = s.expenses.slice().sort((a, b) => b.a - a.a).slice(0, 5);

  $("#v-month").innerHTML = `
    <div class="no-print">${modeSeg()}</div>
    <div class="print-head"><b>${esc(t("reportTitle", monthLabel(y, m)))}</b><span>${esc((data.profile && data.profile.name) || "")}</span></div>
    ${pager("month", monthLabel(y, m))}
    <div class="hero"><span class="eyebrow">${esc(t("monthExpense"))}</span>
      <div class="big"><span class="cur">${esc(cur())}</span>${fmt(s.total)}</div>${deltaHTML(C.percentChange(s.total, prevTotal), t.bind(null, isCur ? "vsMonthSoFar" : "vsMonth"))}</div>

    <div class="stats">
      <div class="stat"><small>${esc(t("monthIncome"))}</small><b>${esc(money(s.income))}</b></div>
      <div class="stat"><small>${esc(t("balance"))}</small><b class="${s.balance < 0 ? "neg" : "pos"}">${esc(money(s.balance))}</b></div>
      <div class="stat"><small>${esc(t("dailyAvg"))}</small><b>${esc(money(s.average))}</b></div>
      <div class="stat we"><small>${esc(t("weekend"))}</small><b>${esc(money(s.weekend))}</b></div>
      ${isCur ? `<div class="stat"><small>${esc(t("projected"))}</small><b>${esc(money(s.projected))}</b></div>` : ""}
      <div class="stat"><small>${esc(t("topDay"))}</small><b>${s.topDay >= 0 ? `${esc(fmt(s.perDay[s.topDay]))} <em>${esc(shortDate(C.toISO(new Date(y, m, s.topDay + 1))))}</em>` : "–"}</b></div>
      ${isCur ? "" : `<div class="stat"><small>${esc(t("entries"))}</small><b>${s.count}</b></div>`}
    </div>

    <div class="cols">
      <div class="stack">
        <div class="card stack">
          <div class="row-between"><h3>${esc(t("budgetTotal"))}</h3><span class="muted">${b ? esc(`${fmt(s.total)} / ${fmt(b)}`) : ""}</span></div>
          ${b ? `<div class="track ${s.total > b ? "over" : s.total > b * 0.8 ? "warn" : ""}"><span style="width:${pct.toFixed(1)}%"></span></div>
            <span class="${s.total > b ? "neg" : "muted"}">${esc(s.total > b ? t("over", money(s.total - b)) : t("left", money(b - s.total)))}</span>`
            : `<button type="button" class="link left" data-nav="settings">${esc(t("noBudget"))}</button>`}
        </div>
        <div class="card stack"><h3>${esc(t("byCategory"))}</h3>${catBars(s.byCategory, s.total, data.budget.byCat)}</div>
        <div class="card stack"><h3>${esc(t("byMethod"))}</h3>${s.byMethod.length ? `<div class="methods-row">${s.byMethod.map(([k, v]) => `<div class="stat"><small>${esc(methodName(k))}</small><b>${esc(money(v))}</b></div>`).join("")}</div>` : `<p class="muted">${esc(t("emptyPeriod"))}</p>`}</div>
      </div>
      <div class="stack">
        <div class="card stack"><h3>${esc(t("perDay"))}</h3>
          <div class="spark">${s.perDay.map((v, i) => { const d = new Date(y, m, i + 1); return `<span class="${v ? (C.isWeekend(d) ? "we" : "") : "z"}" style="height:${v ? Math.max((v / max) * 100, 3) : 2}%" title="${esc(shortDate(C.toISO(d)))}: ${fmt(v)}"></span>`; }).join("")}</div>
          <div class="axis"><span>1</span><span>${Math.ceil(s.days / 2)}</span><span>${s.days}</span></div>
          <div class="legend"><span><i class="k-wd"></i>${esc(t("weekdays"))}</span><span><i class="k-we"></i>${esc(t("weekend"))}</span></div>
        </div>
        <div class="card stack"><h3>${esc(t("byWeek"))}</h3>
          <table class="tbl"><thead><tr><th>${esc(t("week"))}</th><th class="r we">${esc(t("weekend"))}</th><th class="r">${esc(t("total"))}</th></tr></thead>
          <tbody>${s.weeks.map((w) => `<tr><td>${esc(shortDate(w.from))} – ${esc(shortDate(w.to))}</td><td class="r num we">${fmt(w.weekend)}</td><td class="r num">${fmt(w.total)}</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="card stack"><h3>${esc(t("biggest"))}</h3>${big.length ? listHTML(big, { showDate: true }) : `<p class="muted">${esc(t("emptyPeriod"))}</p>`}</div>
      </div>
    </div>

    <div class="card stack year">
      <div class="row-between"><h3>${esc(t("year"))} ${y}</h3><span class="muted">${esc(t("yearExpense"))}: <b>${esc(money(year.expense))}</b> · ${esc(t("yearIncome"))}: <b>${esc(money(year.income))}</b></span></div>
      <div class="ybars">${year.months.map((x) => `<button type="button" class="ybar${x.month === m ? " sel" : ""}" data-action="pick-month" data-y="${y}" data-m="${x.month}" title="${esc(monthLabel(y, x.month))}: ${esc(money(x.expense))}">
        <span class="pair"><span class="inc" style="height:${((x.income / ymax) * 100).toFixed(1)}%"></span><span class="exp" style="height:${((x.expense / ymax) * 100).toFixed(1)}%"></span></span>
        <span class="lb">${esc(MONTHS[lang][x.month].slice(0, lang === "si" ? 4 : 3))}</span></button>`).join("")}</div>
      <div class="legend"><span><i class="k-exp"></i>${esc(t("expense"))}</span><span><i class="k-inc"></i>${esc(t("income"))}</span></div>
    </div>

    <div class="actions no-print">
      <button class="btn" type="button" data-action="copy-summary">${esc(t("copySummary"))}</button>
      <button class="btn ghost" type="button" data-action="print">${esc(t("print"))}</button>
      <button class="btn ghost" type="button" data-action="export-month">${esc(t("exportCsv"))}</button>
    </div>
    <p class="print-foot">${esc(t("made"))}</p>`;
}

function summaryText() {
  const [y, m] = monthYM(off.month);
  const s = C.monthSummary(data.entries, y, m, new Date());
  const lines = [t("reportTitle", monthLabel(y, m)), "",
    `${t("monthExpense")}: ${money(s.total)}`, `${t("monthIncome")}: ${money(s.income)}`, `${t("balance")}: ${money(s.balance)}`,
    `${t("dailyAvg")}: ${money(s.average)}`, `${t("weekend")}: ${money(s.weekend)}`];
  if (data.budget.total) lines.push(`${t("budgetTotal")}: ${money(data.budget.total)} (${s.total > data.budget.total ? t("over", money(s.total - data.budget.total)) : t("left", money(data.budget.total - s.total))})`);
  if (s.byCategory.length) { lines.push("", t("byCategory") + ":"); s.byCategory.forEach(([c, v]) => lines.push(`• ${catName(c)}: ${money(v)} (${Math.round((v / s.total) * 100)}%)`)); }
  return lines.join("\n");
}

/* ============================================================
   HISTORY
   ============================================================ */
let histLimit = 200;
function renderHistory() {
  const sel = $("#h-cat"), keep = sel.value;
  sel.innerHTML = `<option value="">${esc(t("all"))}</option>` + data.categories.map((c) => `<option value="${esc(c.id)}">${esc(c[lang] || c.en)}</option>`).join("");
  sel.value = keep;
  const list = filteredHistory();
  const exp = C.sum(C.expenses(list)), inc = C.sum(C.incomes(list));
  $("#h-count").textContent = t("results", list.length, money(exp) + (inc ? ` · +${fmt(inc)}` : ""));
  if (!list.length) { $("#h-list").innerHTML = `<div class="empty">${esc(t("noResults"))}</div>`; return; }
  const shown = list.slice(0, histLimit);
  const days = [...new Set(shown.map((e) => e.d))];
  $("#h-list").innerHTML = days.map((d) => {
    const items = shown.filter((e) => e.d === d);
    return `<div class="day"><div class="dayhead"><span>${esc(dayLabel(d))}</span><span class="num">${fmt(C.sum(C.expenses(items)))}</span></div>${listHTML(items)}</div>`;
  }).join("") + (list.length > histLimit ? `<button class="btn ghost wide" data-action="more">+ ${list.length - histLimit}</button>` : "");
}
function filteredHistory() {
  const q = $("#h-q").value.trim().toLowerCase();
  const c = $("#h-cat").value, from = $("#h-from").value, to = $("#h-to").value;
  return data.entries.filter((e) => (!c || e.c === c) && (!from || e.d >= from) && (!to || e.d <= to) &&
      (!q || (e.n || "").toLowerCase().includes(q) || catName(e.c).toLowerCase().includes(q) || String(e.a).includes(q)))
    .sort((a, b) => b.d.localeCompare(a.d) || b.id.localeCompare(a.id));
}

/* ============================================================
   SETTINGS
   ============================================================ */
let newCatColor = PALETTE[0];
function renderSettings() {
  const isCloud = backend && backend.kind === "cloud";
  const u = isCloud ? backend.user : null;
  const p = data.profile || {};
  const exCats = data.categories.filter((c) => c.type === "exp");

  const account = isCloud ? `
    <div class="card stack" id="s-account">
      <h3>${esc(t("profile"))}</h3>
      <div class="profile-row">
        <span class="avatar xl">${avatarHTML(72)}</span>
        <div class="stack tight">
          <button class="btn ghost sm" type="button" data-action="photo">${esc(t("changePhoto"))}</button>
          ${p.photo ? `<button class="link left" type="button" data-action="photo-remove">${esc(t("removePhoto"))}</button>` : ""}
        </div>
      </div>
      <div class="inline-form"><div class="field grow"><label for="s-name">${esc(t("yourName"))}</label><input id="s-name" maxlength="40" value="${esc(p.name || "")}"></div><button class="btn ghost" type="button" data-action="save-name">${esc(t("saveName"))}</button></div>
      <div class="kv"><span>${esc(t("email"))}</span><b>${esc(u.email)}</b></div>
      <div class="kv"><span></span>${u.emailVerified ? `<span class="pill ok">${esc(t("emailVerified"))}</span>` : `<span class="pill warn">${esc(t("emailUnverified"))}</span> <button class="link" type="button" data-action="verify">${esc(t("resendVerify"))}</button>`}</div>
      <details><summary>${esc(t("changePw"))}</summary>
        <form id="f-pw" class="stack" novalidate>
          <div class="field"><label for="pw-cur">${esc(t("currentPw"))}</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
          <div class="field"><label for="pw-new">${esc(t("newPw"))}</label><input id="pw-new" type="password" autocomplete="new-password"></div>
          <div class="field"><label for="pw-new2">${esc(t("password2"))}</label><input id="pw-new2" type="password" autocomplete="new-password"></div>
          <p class="form-err" id="pw-err" hidden></p>
          <button class="btn" type="submit">${esc(t("changePw"))}</button>
        </form>
      </details>
      <div class="row-actions"><button class="btn ghost" type="button" data-action="signout">${esc(t("signOut"))}</button></div>
    </div>` : `
    <div class="card stack"><h3>${esc(t("account"))}</h3>
      <p class="muted">${esc(cloud ? t("guestBanner") : t("privacy"))}</p>
      ${cloud ? `<div class="row-actions"><button class="btn" type="button" data-action="to-signup">${esc(t("createAccount"))}</button><button class="btn ghost" type="button" data-action="to-login">${esc(t("login"))}</button></div>` : ""}
    </div>`;

  $("#v-settings").innerHTML = `
    <div class="settings-grid">
    <div class="stack">
    ${account}
    ${booksCard(isCloud)}
    <div class="card stack">
      <h3>${esc(t("sLanguage"))} · ${esc(t("sTheme"))}</h3>
      <div class="seg" role="group">${["si", "en"].map((l) => `<button type="button" data-lang="${l}" aria-pressed="${lang === l}">${l === "si" ? "සිංහල" : "English"}</button>`).join("")}</div>
      <div class="seg" role="group">${["system", "light", "dark"].map((th) => `<button type="button" data-action="theme" data-theme-v="${th}" aria-pressed="${data.settings.theme === th}">${esc(t("t" + th[0].toUpperCase() + th.slice(1)))}</button>`).join("")}</div>
      <div class="inline-form"><div class="field"><label for="s-cur">${esc(t("sCurrency"))}</label><input id="s-cur" maxlength="6" value="${esc(cur())}" style="max-width:8rem"></div><button class="btn ghost" type="button" data-action="save-cur">${esc(t("save"))}</button></div>
    </div>

    <div class="card stack">
      <h3>${esc(t("sBudgets"))}</h3><p class="muted">${esc(t("sBudgetHelp"))}</p>
      <div class="budget-grid">
        <div class="field full"><label for="b-total">${esc(t("budgetTotal"))} (${esc(cur())})</label><input id="b-total" inputmode="decimal" value="${data.budget.total || ""}"></div>
        ${exCats.map((c) => `<div class="field"><label for="b-${esc(c.id)}"><i class="dot" style="background:${esc(c.color)}"></i>${esc(c[lang] || c.en)}</label><input id="b-${esc(c.id)}" data-bcat="${esc(c.id)}" inputmode="decimal" value="${data.budget.byCat[c.id] || ""}"></div>`).join("")}
      </div>
      <div class="row-actions"><button class="btn" type="button" data-action="save-budget">${esc(t("save"))}</button></div>
    </div>
    </div>

    <div class="stack">
    ${reminderCard()}
    <div class="card stack">
      <h3>${esc(t("sRecurring"))}</h3><p class="muted">${esc(t("sRecurringHelp"))}</p>
      ${data.recurring.length ? `<div class="list">${data.recurring.map((r) => `<div class="item${r.type === "inc" ? " inc" : ""}${r.paused ? " paused" : ""}">
        <i class="sw" style="background:${esc(catById(r.c).color)}"></i>
        <div class="txt"><b>${esc(r.n || catName(r.c))}</b><span>${esc(t("everyMonth", r.day))}${r.paused ? " · " + esc(t("paused")) : ""}</span></div>
        <span class="amt">${r.type === "inc" ? "+" : ""}${fmt(r.a)}</span>
        <span class="acts"><button class="btn ghost sm" type="button" data-action="rec-toggle" data-id="${esc(r.id)}">${esc(r.paused ? t("resume") : t("pause"))}</button><button class="iconbtn" type="button" data-action="rec-del" data-id="${esc(r.id)}" aria-label="${esc(t("del"))}">${ICON.del}</button></span></div>`).join("")}</div>` : ""}
      <form id="f-rec" class="rec-form" novalidate>
        <div class="field"><label for="r-cat">${esc(t("category"))}</label><select id="r-cat">${data.categories.map((c) => `<option value="${esc(c.id)}">${esc((c.type === "inc" ? "+ " : "") + (c[lang] || c.en))}</option>`).join("")}</select></div>
        <div class="field"><label for="r-amt">${esc(t("amount"))}</label><input id="r-amt" inputmode="decimal"></div>
        <div class="field"><label for="r-note">${esc(t("note"))}</label><input id="r-note" maxlength="60" placeholder="${lang === "si" ? "උදා: නිවසේ කුලිය" : "e.g. House rent"}"></div>
        <div class="field"><label for="r-day">${esc(t("dayOfMonth"))}</label><input id="r-day" type="number" min="1" max="31" value="1"></div>
        <p class="form-err" id="r-err" hidden></p>
        <button class="btn ghost" type="submit">+ ${esc(t("addRecurring"))}</button>
      </form>
    </div>

    <div class="card stack">
      <h3>${esc(t("sCategories"))}</h3>
      <div class="chips">${data.categories.map((c) => `<span class="chip static"><i style="background:${esc(c.color)}"></i>${c.type === "inc" ? "+ " : ""}${esc(c[lang] || c.en)}${c.custom ? `<button type="button" class="x" data-action="cat-del" data-id="${esc(c.id)}" aria-label="${esc(t("del"))}">×</button>` : ""}</span>`).join("")}</div>
      <form id="f-cat" class="inline-form wrap" novalidate>
        <div class="field grow"><label for="c-name">${esc(t("sAddCat"))}</label><input id="c-name" maxlength="30" placeholder="${esc(t("catNamePh"))}"></div>
        <div class="field"><label for="c-type">${esc(t("expense"))}/${esc(t("income"))}</label><select id="c-type"><option value="exp">${esc(t("expense"))}</option><option value="inc">${esc(t("income"))}</option></select></div>
        <div class="swatches" role="group">${PALETTE.map((col) => `<button type="button" class="swatch" data-color="${col}" style="background:${col}" aria-pressed="${newCatColor === col}" aria-label="${col}"></button>`).join("")}</div>
        <button class="btn ghost" type="submit">+ ${esc(t("add"))}</button>
      </form>
    </div>

    <div class="card stack">
      <h3>${esc(t("sBackup"))}</h3><p class="muted">${esc(t("sBackupHelp"))}</p>
      <div class="row-actions wrap">
        <button class="btn ghost" type="button" data-action="backup">${esc(t("backup"))}</button>
        <button class="btn ghost" type="button" data-action="restore">${esc(t("restore"))}</button>
        <button class="btn ghost" type="button" data-action="export-all">${esc(t("exportCsv"))}</button>
      </div>
    </div>

    ${installEvent ? `<div class="card stack"><h3>${esc(t("install"))}</h3><p class="muted">${esc(t("installHelp"))}</p><div class="row-actions"><button class="btn" type="button" data-action="install">${esc(t("install"))}</button></div></div>` : ""}

    <div class="card stack danger-zone">
      <div class="row-actions wrap">
        ${!data.book || data.book.owner === backend.user?.uid ? `<button class="btn ghost danger-t" type="button" data-action="reset">${esc(t("sDanger"))}</button>` : ""}
        ${isCloud ? `<button class="btn ghost danger-t" type="button" data-action="delete-account">${esc(t("deleteAccount"))}</button>` : ""}
      </div>
      <p class="tiny muted">${esc(isCloud ? "" : t("privacy"))} v2.0</p>
    </div>
    </div>
    </div>`;
}

/* ============================================================
   Shared family books
   ============================================================ */
function booksCard(isCloud) {
  if (!isCloud) return `<div class="card stack" id="s-books"><h3>${esc(t("sBooks"))}</h3><p class="muted">${esc(t("booksNeedAccount"))}</p></div>`;
  const uid = backend.user.uid;
  const rows = myBooks.map((b) => {
    const owner = b.owner === uid;
    const names = b.memberNames || {};
    return `<div class="bookrow ${b.id === backend.bookId ? "active" : ""}">
      <div class="row-between"><b>👨‍👩‍👧 ${esc(b.name)}</b>${b.id === backend.bookId ? `<span class="pill ok">${esc(t("bookOpen"))}</span>` : `<button class="btn ghost sm" type="button" data-action="book-open" data-id="${esc(b.id)}">${esc(t("bookOpenBtn"))}</button>`}</div>
      <div class="chips">${(b.members || []).map((u) => `<span class="chip static">${esc(names[u] || "…")}${u === b.owner ? ` <small class="muted">${esc(t("owner"))}</small>` : ""}${owner && u !== uid ? `<button type="button" class="x" data-action="book-kick" data-id="${esc(b.id)}" data-uid="${esc(u)}" aria-label="${esc(t("removeMember"))}">×</button>` : ""}</span>`).join("")}</div>
      <div class="invite"><span class="muted">${esc(t("inviteCode"))}</span><code>${esc(b.inviteCode || "")}</code>
        <button class="btn ghost sm" type="button" data-action="book-copy" data-id="${esc(b.id)}">${esc(t("copy"))}</button>
        <a class="btn ghost sm" href="https://wa.me/?text=${encodeURIComponent(t("inviteMsg", b.name, b.inviteCode, appURL()))}" target="_blank" rel="noopener">WhatsApp</a></div>
      <div class="row-actions wrap">
        ${owner ? `<button class="btn ghost sm" type="button" data-action="book-rename" data-id="${esc(b.id)}">${esc(t("rename"))}</button>
        <button class="btn ghost sm" type="button" data-action="book-recode" data-id="${esc(b.id)}">${esc(t("newCode"))}</button>
        <button class="btn ghost sm danger-t" type="button" data-action="book-delete" data-id="${esc(b.id)}">${esc(t("deleteBook"))}</button>`
        : `<button class="btn ghost sm danger-t" type="button" data-action="book-leave" data-id="${esc(b.id)}">${esc(t("leaveBook"))}</button>`}
      </div></div>`;
  }).join("");
  return `<div class="card stack" id="s-books">
    <h3>${esc(t("sBooks"))}</h3><p class="muted">${esc(t("sBooksHelp"))}</p>
    ${rows}
    <form id="f-book-new" class="inline-form" novalidate>
      <div class="field grow"><label for="bk-name">${esc(t("newBook"))}</label><input id="bk-name" maxlength="40" placeholder="${esc(t("newBookPh"))}"></div>
      <button class="btn" type="submit">${esc(t("create"))}</button></form>
    <form id="f-book-join" class="inline-form" novalidate>
      <div class="field grow"><label for="bk-code">${esc(t("joinBook"))}</label><input id="bk-code" maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="ABCD2345" class="code-in"></div>
      <button class="btn ghost" type="submit">${esc(t("join"))}</button></form>
    <p class="form-err" id="bk-err" hidden></p>
  </div>`;
}
const bookById = (id) => myBooks.find((b) => b.id === id);
const myName = () => (data.profile && data.profile.name) || backend.user.displayName || backend.user.email;

/* ============================================================
   Daily reminder
   Browsers cannot fire a notification on a schedule when the app is closed without a push server,
   so the dependable route is a repeating calendar event. While the app is open (or in a background
   tab) we also show a notification at the chosen time, and an in-app nudge if nothing was logged.
   ============================================================ */
const rem = () => Object.assign({ on: false, time: "21:00" }, prefs.reminder || {});
const appURL = () => location.origin + location.pathname;
const loggedToday = () => data.entries.some((e) => e.d === todayISO());
function reminderDue() {
  const r = rem(); if (!r.on) return false;
  const [h, mi] = r.time.split(":").map(Number); const n = new Date();
  return n.getHours() * 60 + n.getMinutes() >= h * 60 + mi;
}
function reminderCard() {
  const r = rem();
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  return `<div class="card stack">
    <h3>${esc(t("sReminder"))}</h3><p class="muted">${esc(t("sReminderHelp"))}</p>
    <div class="inline-form">
      <div class="field"><label for="r-time">${esc(t("remTime"))}</label><input id="r-time" type="time" value="${esc(r.time)}" style="max-width:9rem"></div>
      <label class="switch"><input type="checkbox" id="r-on" ${r.on ? "checked" : ""}><span>${esc(t("remOn"))}</span></label>
    </div>
    <div class="row-actions wrap">
      <a class="btn" id="r-gcal" href="${esc(gcalURL(r.time))}" target="_blank" rel="noopener">${esc(t("remGoogle"))}</a>
      <button class="btn ghost" type="button" data-action="rem-ics">${esc(t("remIcs"))}</button>
      ${perm === "default" ? `<button class="btn ghost" type="button" data-action="rem-perm">${esc(t("remAllow"))}</button>` : ""}
    </div>
    <p class="tiny muted">${esc(perm === "granted" ? t("remPermOk") : perm === "denied" ? t("remPermDenied") : t("remCalHelp"))}</p>
  </div>`;
}
function nextAt(time) {
  const [h, mi] = time.split(":").map(Number); const d = new Date(); d.setHours(h, mi, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d;
}
const icsStamp = (d) => `${d.getFullYear()}${C.pad(d.getMonth() + 1)}${C.pad(d.getDate())}T${C.pad(d.getHours())}${C.pad(d.getMinutes())}00`;
function gcalURL(time) {
  const s = nextAt(time), e = new Date(s.getTime() + 10 * 60000);
  const q = new URLSearchParams({ action: "TEMPLATE", text: t("remEventTitle"), details: `${t("remEventBody")}\n${appURL()}`, dates: `${icsStamp(s)}/${icsStamp(e)}`, recur: "RRULE:FREQ=DAILY", ctz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Colombo" });
  return "https://calendar.google.com/calendar/render?" + q.toString();
}
function icsFile(time) {
  const s = nextAt(time), e = new Date(s.getTime() + 10 * 60000), now = new Date();
  const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Viyadam Pota//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:viyadam-pota-reminder-${Date.now()}@viyadam-pota`, `DTSTAMP:${z(now)}`, `DTSTART:${icsStamp(s)}`, `DTEND:${icsStamp(e)}`,
    "RRULE:FREQ=DAILY", `SUMMARY:${t("remEventTitle")}`, `DESCRIPTION:${t("remEventBody")}\\n${appURL()}`, `URL:${appURL()}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${t("remEventTitle")}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
let remTimer = null;
function scheduleReminder() {
  clearTimeout(remTimer);
  const r = rem(); if (!r.on) return;
  const ms = Math.min(nextAt(r.time) - new Date(), 2 ** 31 - 1);
  remTimer = setTimeout(() => { fireReminder(); scheduleReminder(); }, ms);
}
async function fireReminder() {
  if (!backend || loggedToday()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") { if (!document.hidden) renderBanner(); return; }
  const opts = { body: t("remEventBody"), icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "daily-reminder" };
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) return reg.showNotification(t("remEventTitle"), opts); } catch {}
  try { new Notification(t("remEventTitle"), opts); } catch {}
}

/* ============================================================
   Photo: crop to a square and shrink so it fits inside the profile document
   ============================================================ */
async function photoFromFile(file) {
  const img = await createImageBitmap(file);
  const size = 160, s = Math.min(img.width, img.height);
  const cv = Object.assign(document.createElement("canvas"), { width: size, height: size });
  cv.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return cv.toDataURL("image/jpeg", 0.82);
}

/* ============================================================
   Events (delegated)
   ============================================================ */
const parseLimit = (v) => { const n = C.parseAmount(v); return n > 0 ? n : 0; };

async function onAction(a, el) {
  switch (a) {
    case "edit": return startEdit(el.dataset.id);
    case "delete": return deleteEntry(el.dataset.id);
    case "quick": {
      const q = $("#quick").combos[+el.dataset.i];
      backend.putEntries([{ id: newId(), type: "exp", d: todayISO(), a: q.a, c: q.c, n: q.n, pm: q.pm }]);
      return toast(`${t("added")} · ${money(q.a)}`);
    }
    case "add-income":
      form.type = "inc"; form.cat = data.categories.some((c) => c.id === "salary") ? "salary" : null;
      renderEntryForm(); $("#f-entry").scrollIntoView({ behavior: "smooth", block: "start" }); $("#e-amount").focus({ preventScroll: true });
      return;
    case "prev-week": off.week--; return renderWeek();
    case "next-week": off.week++; return renderWeek();
    case "prev-month": off.month--; return renderMonth();
    case "next-month": off.month++; return renderMonth();
    case "mode-month": monthMode = "month"; return renderMonth();
    case "mode-trends": monthMode = "trends"; return renderMonth();
    case "trend-n": trendN = +el.dataset.n; return renderMonth();
    case "scan": return $("#file-bill").click();
    case "book-open": setActiveBook(backend.user, el.dataset.id); return go("today");
    case "book-copy": {
      const b = bookById(el.dataset.id); if (!b) return;
      const txt = t("inviteMsg", b.name, b.inviteCode, appURL());
      try { await navigator.clipboard.writeText(txt); toast(t("inviteCopied")); } catch { toast(b.inviteCode); }
      return;
    }
    case "book-kick": {
      const b = bookById(el.dataset.id); const nm = (b.memberNames || {})[el.dataset.uid] || "";
      if ((await ask(t("kickAsk", nm), t("removeMember"))).ok) { try { await cloud.removeMember(b.id, el.dataset.uid); toast(t("done")); } catch (e) { toast(t("e_auth_other")); } }
      return;
    }
    case "book-leave": {
      const b = bookById(el.dataset.id);
      if (!(await ask(t("leaveAsk", b.name), t("leaveBook"))).ok) return;
      try { if (backend.bookId === b.id) setActiveBook(backend.user, null); await cloud.leaveBook(backend.user, b.id); toast(t("done")); } catch (e) { toast(t("e_auth_other")); }
      return;
    }
    case "book-delete": {
      const b = bookById(el.dataset.id);
      if (!(await ask(t("deleteBookAsk", b.name), t("deleteBook"))).ok) return;
      try { if (backend.bookId === b.id) setActiveBook(backend.user, null); await cloud.deleteBook(b); toast(t("done")); } catch (e) { console.error(e); toast(t("e_auth_other")); }
      return;
    }
    case "book-recode": {
      const b = bookById(el.dataset.id);
      if (!(await ask(t("newCodeAsk"), t("newCode"), { danger: false })).ok) return;
      try { await cloud.resetInvite(b); toast(t("done")); } catch (e) { console.error(e); toast(t("e_auth_other")); }
      return;
    }
    case "book-rename": {
      const b = bookById(el.dataset.id);
      const r = await ask(t("renameAsk"), t("save"), { danger: false, text: b.name });
      if (r.ok && r.value && r.value.trim()) { try { await cloud.renameBook(b.id, r.value.trim().slice(0, 40)); } catch (e) { toast(t("e_auth_other")); } }
      return;
    }
    case "rem-ics": return download("viyadam-pota-reminder.ics", icsFile(rem().time), "text/calendar;charset=utf-8");
    case "rem-perm": {
      try { await Notification.requestPermission(); } catch {}
      if (Notification.permission === "granted") { prefs.reminder = { ...rem(), on: true }; savePrefs(); scheduleReminder(); }
      return renderSettings();
    }
    case "pick-month": {
      const n = new Date();
      off.month = (+el.dataset.y - n.getFullYear()) * 12 + (+el.dataset.m - n.getMonth());
      renderMonth(); return window.scrollTo({ top: 0, behavior: "smooth" });
    }
    case "copy-summary": {
      const txt = summaryText();
      try { await navigator.clipboard.writeText(txt); toast(t("copied")); }
      catch { download("summary.txt", txt, "text/plain;charset=utf-8"); }
      return;
    }
    case "print": return window.print();
    case "export-month": {
      const [y, m] = monthYM(off.month);
      const s = C.monthSummary(data.entries, y, m);
      return download(`expenses-${y}-${C.pad(m + 1)}.csv`, C.toCSV([...s.expenses, ...s.incomes], catName, methodName), "text/csv;charset=utf-8");
    }
    case "export-filtered": return download(`expenses-filtered.csv`, C.toCSV(filteredHistory(), catName, methodName), "text/csv;charset=utf-8");
    case "export-all": return download(`expenses-all.csv`, C.toCSV(data.entries, catName, methodName), "text/csv;charset=utf-8");
    case "more": histLimit += 200; return renderHistory();
    case "theme": {
      const th = el.dataset.themeV;
      prefs.theme = th; savePrefs(); applyTheme(th);
      return backend.putMeta({ settings: { ...data.settings, theme: th } });
    }
    case "save-cur": {
      const v = $("#s-cur").value.trim().slice(0, 6) || "Rs";
      backend.putMeta({ settings: { ...data.settings, currency: v } });
      return toast(t("save") + " ✓");
    }
    case "save-budget": {
      const byCat = {};
      $$("[data-bcat]").forEach((i) => { const v = parseLimit(i.value); if (v) byCat[i.dataset.bcat] = v; });
      backend.putMeta({ budget: { total: parseLimit($("#b-total").value), byCat } });
      return toast(t("save") + " ✓");
    }
    case "rec-toggle": return backend.putMeta({ recurring: data.recurring.map((r) => (r.id === el.dataset.id ? { ...r, paused: !r.paused } : r)) });
    case "rec-del": {
      const r = data.recurring.find((x) => x.id === el.dataset.id);
      const res = await ask(`${t("del")}: ${r ? r.n || catName(r.c) : ""}?`, t("confirm"));
      if (res.ok) backend.putMeta({ recurring: data.recurring.filter((x) => x.id !== el.dataset.id) });
      return;
    }
    case "cat-del": {
      const id = el.dataset.id; const c = catById(id);
      const used = data.entries.filter((e) => e.c === id);
      if (used.length) {
        const res = await ask(t("catInUse"), t("confirm"));
        if (!res.ok) return;
        const fallback = c.type === "inc" ? "gift" : "other";
        backend.putEntries(used.map((e) => ({ ...e, c: fallback })));
      }
      const byCat = { ...data.budget.byCat }; delete byCat[id];
      return backend.putMeta({ categories: data.categories.filter((x) => x.id !== id), budget: { ...data.budget, byCat } });
    }
    case "backup": {
      const out = { app: "viyadam-pota", exported: new Date().toISOString(), ...data };
      delete out.profile;
      return download(`viyadam-pota-backup-${todayISO()}.json`, JSON.stringify(out, null, 1), "application/json");
    }
    case "restore": return $("#file-restore").click();
    case "reset": {
      const res = await ask(t("resetAsk"), t("confirm"));
      if (res.ok) { await backend.clear(); toast(t("resetDone")); }
      return;
    }
    case "install": installEvent.prompt(); installEvent = null; return renderSettings();
    case "close-guest": guestBannerClosed = true; return renderBanner();
    case "to-signup": case "to-login":
      stopBackend(); prefs.mode = "account"; savePrefs(); return showAuth(a === "to-signup" ? "signup" : "login");
    case "guest": return startGuest();
    case "forgot": $("#fg-email").value = $("#li-email").value; return authTab("forgot");
    // account
    case "photo": return $("#file-photo").click();
    case "photo-remove": backend.putMeta({ profile: { ...data.profile, photo: "" } }); return;
    case "save-name": {
      const name = $("#s-name").value.trim();
      if (!name) return toast(t("nameReq"));
      backend.putMeta({ profile: { ...data.profile, name } });
      return toast(t("nameSaved"));
    }
    case "verify": try { await cloud.resendVerification(lang); toast(t("verifySent")); } catch (e) { toast(t(cloud.authErrorKey(e))); } return;
    case "signout": if (booksUnsub) booksUnsub(); booksUnsub = null; booksFor = null; myBooks = []; stopBackend(); data = emptyData(); view = "today"; prefs.mode = "account"; savePrefs(); await cloud.signOutUser(); return;
    case "delete-account": {
      const res = await ask(t("deleteAccountAsk"), t("deleteAccount"), { password: true });
      if (!res.ok || !res.value) return;
      try { stopBackend(); await cloud.deleteAccount(res.value); toast(t("accountDeleted")); }
      catch (e) { toast(t(cloud.authErrorKey(e))); const u = cloud.currentUser(); if (u) startAccount(u); }
      return;
    }
  }
}

function wireStatic() {
  wireAuth();
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action],[data-nav],[data-lang],[data-type],[data-cat],[data-method],[data-color]");
    if (!el) return;
    if (el.dataset.nav) return go(el.dataset.nav);
    if (el.dataset.lang) { prefs.langTouched = true; return setLang(el.dataset.lang); }
    if (el.dataset.type) { form.type = el.dataset.type; form.cat = null; return renderEntryForm(); }
    if (el.dataset.cat) { form.cat = el.dataset.cat; return renderEntryForm(); }
    if (el.dataset.method) { form.method = el.dataset.method; return renderEntryForm(); }
    if (el.dataset.color) { newCatColor = el.dataset.color; $$(".swatch").forEach((s) => s.setAttribute("aria-pressed", s.dataset.color === newCatColor)); return; }
    onAction(el.dataset.action, el);
  });
  $("#f-entry").addEventListener("submit", submitEntry);
  $("#e-cancel").addEventListener("click", resetEntryForm);
  ["#h-q", "#h-cat", "#h-from", "#h-to"].forEach((s) => $(s).addEventListener("input", () => { histLimit = 200; renderHistory(); }));

  // forms rendered inside Settings
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.id === "f-rec") {
      e.preventDefault();
      const a = C.parseAmount($("#r-amt").value);
      if (!(a > 0)) return showErr("#r-err", t("errAmount"));
      const c = catById($("#r-cat").value);
      const day = Math.min(31, Math.max(1, parseInt($("#r-day").value, 10) || 1));
      const rec = { id: newId(), type: c.type, a, c: c.id, n: $("#r-note").value.trim(), pm: "online", day, start: todayISO() };
      // if today's date already passed this month's day, start from next month
      const now = new Date();
      if (now.getDate() > day) rec.start = C.toISO(new Date(now.getFullYear(), now.getMonth() + 1, 1));
      recurringRanFor = null;
      backend.putMeta({ recurring: [...data.recurring, rec] });
      toast(t("added"));
    } else if (f.id === "f-cat") {
      e.preventDefault();
      const name = $("#c-name").value.trim();
      if (!name) return $("#c-name").focus();
      const cat = { id: "c_" + newId(), si: name, en: name, color: newCatColor, type: $("#c-type").value, custom: true };
      backend.putMeta({ categories: [...data.categories, cat] });
      toast(t("added"));
    } else if (f.id === "f-book-new" || f.id === "f-book-join") {
      e.preventDefault();
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      try {
        let id;
        if (f.id === "f-book-new") {
          const name = $("#bk-name").value.trim().slice(0, 40);
          if (!name) { $("#bk-name").focus(); return; }
          id = await cloud.createBook(backend.user, name, myName(), { categories: data.categories });
          toast(t("bookCreated"));
        } else {
          id = await cloud.joinBook(backend.user, $("#bk-code").value, myName());
          toast(t("bookJoined"));
        }
        setActiveBook(backend.user, id);
      } catch (err) {
        if (err.message !== "bad-code") console.error(err);
        showErr("#bk-err", t(err.message === "bad-code" ? "badCode" : "e_auth_other"));
      } finally { btn.disabled = false; }
    } else if (f.id === "f-pw") {
      e.preventDefault();
      const cur0 = $("#pw-cur").value, n1 = $("#pw-new").value, n2 = $("#pw-new2").value;
      if (n1.length < 8) return showErr("#pw-err", t("pwShort"));
      if (n1 !== n2) return showErr("#pw-err", t("pwMismatch"));
      try { await cloud.changePassword(cur0, n1); toast(t("pwChanged")); f.reset(); showErr("#pw-err", ""); }
      catch (err) { const k = cloud.authErrorKey(err); showErr("#pw-err", t(k === "e_auth_invalid" ? "pwCurWrong" : k)); }
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "book-sel") {
      const v = e.target.value;
      if (v === "__manage") { e.target.value = backend.bookId || ""; go("settings"); setTimeout(() => $("#s-books")?.scrollIntoView({ behavior: "smooth" }), 50); return; }
      setActiveBook(backend.user, v || null);
      return;
    }
    if (e.target.id === "r-time" || e.target.id === "r-on") {
      prefs.reminder = { on: $("#r-on").checked, time: $("#r-time").value || "21:00" }; savePrefs();
      const g = $("#r-gcal"); if (g) g.href = gcalURL(prefs.reminder.time);
      scheduleReminder(); toast(prefs.reminder.on ? t("remSaved", prefs.reminder.time) : t("remOffMsg"));
    }
  });
  $("#file-bill").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    const st = $("#scan-status"), btn = $(".scan-btn");
    const show = (html, kind = "") => { st.className = "scan-status " + kind; st.innerHTML = html; st.hidden = false; };
    btn.disabled = true;
    show(`<span class="spin"></span> ${esc(t("scanLoading"))}`);
    try {
      const { scanReceipt } = await import("./receipt.js");
      const r = await scanReceipt(file, (p) => show(`<span class="spin"></span> ${esc(t("scanReading", Math.round(p * 100)))}`));
      if (r.amount) {
        if (form.type !== "exp") { form.type = "exp"; form.cat = null; }
        $("#e-amount").value = r.amount;
        if (r.date) $("#e-date").value = r.date;
        if (r.merchant && !$("#e-note").value) $("#e-note").value = r.merchant;
        if (r.category && data.categories.some((c) => c.id === r.category)) form.cat = r.category;
        renderEntryForm();
        show(`${esc(t(r.confidence === "high" ? "scanFound" : "scanGuess", money(r.amount)))}${r.date ? " · " + esc(shortDate(r.date)) : ""}`, r.confidence === "high" ? "ok" : "warn");
        $("#e-amount").focus();
      } else show(esc(t("scanNone")), "warn");
    } catch (err) {
      console.error(err);
      show(esc(t(navigator.onLine === false ? "scanOffline" : "scanFail")), "warn");
    } finally { btn.disabled = false; }
  });
  $("#file-restore").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || !Array.isArray(raw.entries)) throw new Error("bad");
      const next = normalise(raw);
      const res = await ask(`${t("restoreAsk")} (${next.entries.length})`, t("restore"));
      if (!res.ok) return;
      await backend.replaceAll({ ...next, settings: data.settings, profile: data.profile });
      recurringRanFor = null;
      toast(t("restored", next.entries.length));
    } catch { toast(t("restoreBad")); }
  });
  $("#file-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try { const photo = await photoFromFile(file); backend.putMeta({ profile: { ...data.profile, photo } }); toast(t("photoSaved")); }
    catch { toast(t("e_auth_other")); }
  });

  // keep "today" right if the app stays open past midnight
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || $("#app").hidden) return;
    if (!form.editing && $("#e-date").value < todayISO()) $("#e-date").value = todayISO();
    runRecurring(); render();
  });
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; if (view === "settings") render(); });
}

function registerSW() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
