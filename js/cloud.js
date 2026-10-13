// Accounts + cloud sync with Firebase Authentication and Cloud Firestore (free "Spark" plan).
// Loaded only when js/firebase-config.js has a config, so guest mode never downloads Firebase.
//
// Firestore layout (protected by firestore.rules — each user can only touch their own documents):
//   users/{uid}                 { profile:{name,photo}, categories, recurring, budget, settings, createdAt }
//   users/{uid}/entries/{id}    { type, d, a, c, n, pm, rec? }

const V = "10.14.1";
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

import { emptyData, normalise } from "./store.js";

let fb = null; // { app, auth, db, A: authModule, F: firestoreModule }

export async function initCloud(config) {
  if (fb) return fb;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${BASE}/firebase-app.js`),
    import(`${BASE}/firebase-auth.js`),
    import(`${BASE}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) {
    db = F.getFirestore(app); // private windows / old browsers without IndexedDB
  }
  fb = { app, auth, db, A, F };
  return fb;
}

/* ---------------- auth ---------------- */

export const onUser = (cb) => fb.A.onAuthStateChanged(fb.auth, cb);

export async function signUp(name, email, password, lang) {
  fb.auth.languageCode = lang;
  const cred = await fb.A.createUserWithEmailAndPassword(fb.auth, email, password);
  await fb.A.updateProfile(cred.user, { displayName: name });
  const base = emptyData();
  base.settings.lang = lang;
  await fb.F.setDoc(fb.F.doc(fb.db, "users", cred.user.uid), {
    profile: { name, photo: "" },
    categories: base.categories, recurring: [], budget: base.budget, settings: base.settings,
    createdAt: fb.F.serverTimestamp(),
  });
  fb.A.sendEmailVerification(cred.user).catch(() => {});
  return cred.user;
}

export const signIn = (email, password) => fb.A.signInWithEmailAndPassword(fb.auth, email, password);

export function resetPassword(email, lang) {
  fb.auth.languageCode = lang;
  return fb.A.sendPasswordResetEmail(fb.auth, email);
}

export const signOutUser = () => fb.A.signOut(fb.auth);

export function resendVerification(lang) {
  fb.auth.languageCode = lang;
  return fb.A.sendEmailVerification(fb.auth.currentUser);
}

async function reauth(password) {
  const u = fb.auth.currentUser;
  await fb.A.reauthenticateWithCredential(u, fb.A.EmailAuthProvider.credential(u.email, password));
}

export async function changePassword(current, next) {
  await reauth(current);
  await fb.A.updatePassword(fb.auth.currentUser, next);
}

export async function deleteAccount(password) {
  await reauth(password);
  const u = fb.auth.currentUser;
  await cleanupBooks(u);
  const entries = await fb.F.getDocs(fb.F.collection(fb.db, "users", u.uid, "entries"));
  await batchedWrite(entries.docs.map((d) => (b) => b.delete(d.ref)));
  await fb.F.deleteDoc(fb.F.doc(fb.db, "users", u.uid));
  await fb.A.deleteUser(u);
}

export const currentUser = () => (fb ? fb.auth.currentUser : null);

/** Map Firebase error codes to our message keys */
export function authErrorKey(err) {
  const c = (err && err.code) || "";
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c)) return "e_auth_invalid";
  if (/email-already-in-use/.test(c)) return "e_auth_exists";
  if (/weak-password/.test(c)) return "e_auth_weak";
  if (/too-many-requests/.test(c)) return "e_auth_many";
  if (/network-request-failed/.test(c)) return "e_auth_network";
  if (/requires-recent-login/.test(c)) return "e_auth_recent";
  return "e_auth_other";
}

async function batchedWrite(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = fb.F.writeBatch(fb.db);
    ops.slice(i, i + 400).forEach((op) => op(b));
    await b.commit();
  }
}

/* ---------------- data backend ---------------- */
// bookId = null → the person's own book (users/{uid}/entries)
// bookId = "…"  → a shared family book (books/{bookId}/entries); profile and settings still come from users/{uid}

const SHARED_KEYS = ["categories", "recurring", "budget"];

export function createCloudBackend(user, bookId = null, { onLost = () => {} } = {}) {
  const { F, db } = fb;
  const userRef = F.doc(db, "users", user.uid);
  const bookRef = bookId ? F.doc(db, "books", bookId) : null;
  const entriesRef = bookId ? F.collection(db, "books", bookId, "entries") : F.collection(db, "users", user.uid, "entries");
  let userMeta = null, bookMeta = bookId ? null : {}, entries = new Map(), gotEntries = false;
  let listener = () => {}, unsubs = [];
  let status = { ok: true, offline: false };

  const snapshot = () => {
    const shared = bookId ? bookMeta || {} : userMeta || {};
    const d = normalise({ ...(userMeta || {}), ...pick(shared, SHARED_KEYS), entries: [...entries.values()] });
    d.profile = { name: (userMeta && userMeta.profile && userMeta.profile.name) || user.displayName || "", photo: (userMeta && userMeta.profile && userMeta.profile.photo) || "" };
    d.book = bookId && bookMeta ? { id: bookId, name: bookMeta.name, owner: bookMeta.owner, members: bookMeta.members || [], memberNames: bookMeta.memberNames || {}, inviteCode: bookMeta.inviteCode } : null;
    return d;
  };
  const ready = () => userMeta && bookMeta && gotEntries;
  const emit = () => { if (ready()) listener(snapshot(), status); };
  const fail = (e) => { console.error(e); status = { ...status, ok: false }; if (ready()) listener(snapshot(), status); };

  const clean = (e) => {
    const o = { type: e.type, d: e.d, a: e.a, c: e.c, n: e.n || "", pm: e.pm || "cash" };
    if (e.rec) o.rec = e.rec;
    if (bookId) o.by = e.by || user.uid;
    return o;
  };

  return {
    kind: "cloud",
    user,
    bookId,
    start(onChange) {
      listener = onChange;
      unsubs.push(F.onSnapshot(userRef, { includeMetadataChanges: true }, (s) => {
        if (!s.exists()) {
          const base = emptyData();
          userMeta = { profile: { name: user.displayName || "", photo: "" }, categories: base.categories, recurring: [], budget: base.budget, settings: base.settings };
          F.setDoc(userRef, { ...userMeta, createdAt: F.serverTimestamp() }).catch(fail);
        } else userMeta = s.data();
        status = { ok: true, offline: s.metadata.fromCache };
        emit();
      }, fail));
      if (bookRef) {
        unsubs.push(F.onSnapshot(bookRef, (s) => {
          if (!s.exists() || !(s.data().members || []).includes(user.uid)) return onLost();
          bookMeta = s.data();
          emit();
        }, () => onLost()));
      }
      unsubs.push(F.onSnapshot(entriesRef, (s) => {
        for (const ch of s.docChanges()) {
          if (ch.type === "removed") entries.delete(ch.doc.id);
          else entries.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
        }
        gotEntries = true;
        emit();
      }, bookId ? () => onLost() : fail));
    },
    stop() { unsubs.forEach((u) => u()); unsubs = []; listener = () => {}; },
    get: snapshot,
    putEntries(list) {
      // optimistic: Firestore's local cache fires the snapshot immediately, even offline
      batchedWrite(list.map((e) => (b) => b.set(F.doc(entriesRef, e.id), clean(e)))).catch(fail);
      return true;
    },
    deleteEntry(id) { F.deleteDoc(F.doc(entriesRef, id)).catch(fail); return true; },
    putMeta(patch) {
      const toUser = {}, toBook = {};
      for (const k of ["profile", "settings"]) if (k in patch) toUser[k] = patch[k];
      for (const k of SHARED_KEYS) if (k in patch) (bookId ? toBook : toUser)[k] = patch[k];
      if (Object.keys(toUser).length) { userMeta = { ...(userMeta || {}), ...toUser }; F.updateDoc(userRef, toUser).catch(fail); }
      if (Object.keys(toBook).length) { bookMeta = { ...(bookMeta || {}), ...toBook }; F.updateDoc(bookRef, toBook).catch(fail); }
      if (bookId && toUser.profile && toUser.profile.name) F.updateDoc(bookRef, { [`memberNames.${user.uid}`]: toUser.profile.name }).catch(() => {});
      emit();
      return true;
    },
    async replaceAll(next) {
      const n = normalise(next);
      await batchedWrite([
        ...[...entries.keys()].map((id) => (b) => b.delete(F.doc(entriesRef, id))),
        ...n.entries.map((e) => (b) => b.set(F.doc(entriesRef, e.id), clean(e))),
      ]);
      await F.updateDoc(bookRef || userRef, pick(n, SHARED_KEYS));
      return true;
    },
    async clear() {
      const base = emptyData();
      await batchedWrite([...entries.keys()].map((id) => (b) => b.delete(F.doc(entriesRef, id))));
      await F.updateDoc(bookRef || userRef, { categories: base.categories, recurring: [], budget: base.budget });
      return true;
    },
  };
}

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o && k in o) r[k] = o[k]; return r; };

/* ---------------- shared family books ---------------- */
// books/{bookId}      { name, owner, members:[uid], memberNames:{uid:name}, inviteCode, categories, recurring, budget, createdAt }
// invites/{code}      { bookId, name, by }   — lets someone with the code find the book

const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function newCode(len = 8) {
  const a = crypto.getRandomValues(new Uint8Array(len));
  return [...a].map((x) => CODE_ABC[x % CODE_ABC.length]).join("");
}

export function watchMyBooks(uid, cb) {
  const { F, db } = fb;
  const q = F.query(F.collection(db, "books"), F.where("members", "array-contains", uid));
  return F.onSnapshot(q, (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name)))), (e) => { console.error(e); cb([]); });
}

export async function createBook(user, name, myName, base) {
  const { F, db } = fb;
  const ref = F.doc(F.collection(db, "books"));
  const code = newCode();
  await F.setDoc(ref, {
    name, owner: user.uid, members: [user.uid], memberNames: { [user.uid]: myName || user.email },
    inviteCode: code, categories: base.categories, recurring: [], budget: { total: 0, byCat: {} }, createdAt: F.serverTimestamp(),
  });
  await F.setDoc(F.doc(db, "invites", code), { bookId: ref.id, name, by: myName || "" });
  return ref.id;
}

/** Throws Error("bad-code") when the code doesn't exist */
export async function joinBook(user, code, myName) {
  const { F, db } = fb;
  code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 6) throw new Error("bad-code");
  const inv = await F.getDoc(F.doc(db, "invites", code));
  if (!inv.exists()) throw new Error("bad-code");
  const bookId = inv.data().bookId;
  await F.updateDoc(F.doc(db, "books", bookId), {
    members: F.arrayUnion(user.uid), [`memberNames.${user.uid}`]: myName || user.email, joinCode: code,
  });
  return bookId;
}

export async function leaveBook(user, bookId) {
  const { F, db } = fb;
  await F.updateDoc(F.doc(db, "books", bookId), { members: F.arrayRemove(user.uid), [`memberNames.${user.uid}`]: F.deleteField() });
}

export async function removeMember(bookId, uid) {
  const { F, db } = fb;
  await F.updateDoc(F.doc(db, "books", bookId), { members: F.arrayRemove(uid), [`memberNames.${uid}`]: F.deleteField() });
}

export async function renameBook(bookId, name) {
  const { F, db } = fb;
  await F.updateDoc(F.doc(db, "books", bookId), { name });
}

/** New invite code; the old one stops working */
export async function resetInvite(book) {
  const { F, db } = fb;
  const code = newCode();
  await F.setDoc(F.doc(db, "invites", code), { bookId: book.id, name: book.name, by: "" });
  await F.updateDoc(F.doc(db, "books", book.id), { inviteCode: code });
  if (book.inviteCode) await F.deleteDoc(F.doc(db, "invites", book.inviteCode)).catch(() => {});
  return code;
}

export async function deleteBook(book) {
  const { F, db } = fb;
  const entries = await F.getDocs(F.collection(db, "books", book.id, "entries"));
  await batchedWrite(entries.docs.map((d) => (b) => b.delete(d.ref)));
  if (book.inviteCode) await F.deleteDoc(F.doc(db, "invites", book.inviteCode)).catch(() => {});
  await F.deleteDoc(F.doc(db, "books", book.id));
}

/** Before deleting an account: leave books others own, delete books this person owns */
export async function cleanupBooks(user) {
  const { F, db } = fb;
  const q = F.query(F.collection(db, "books"), F.where("members", "array-contains", user.uid));
  const s = await F.getDocs(q);
  for (const d of s.docs) {
    const b = { id: d.id, ...d.data() };
    if (b.owner === user.uid) await deleteBook(b); else await leaveBook(user, b.id);
  }
}
