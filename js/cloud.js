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

export function createCloudBackend(user) {
  const { F, db } = fb;
  const userRef = F.doc(db, "users", user.uid);
  const entriesRef = F.collection(db, "users", user.uid, "entries");
  let meta = null, entries = new Map(), gotEntries = false;
  let listener = () => {}, unsubs = [];
  let status = { ok: true, offline: false };

  const snapshot = () => {
    const d = normalise({ ...(meta || {}), entries: [...entries.values()] });
    d.profile = { name: (meta && meta.profile && meta.profile.name) || user.displayName || "", photo: (meta && meta.profile && meta.profile.photo) || "" };
    return d;
  };
  const emit = () => { if (meta && gotEntries) listener(snapshot(), status); };
  const fail = (e) => { console.error(e); status = { ...status, ok: false }; listener(snapshot(), status); };

  const clean = (e) => {
    const o = { type: e.type, d: e.d, a: e.a, c: e.c, n: e.n || "", pm: e.pm || "cash" };
    if (e.rec) o.rec = e.rec;
    return o;
  };

  return {
    kind: "cloud",
    user,
    start(onChange) {
      listener = onChange;
      unsubs.push(F.onSnapshot(userRef, { includeMetadataChanges: true }, async (s) => {
        if (!s.exists()) {
          // account created elsewhere without a profile doc: create one
          const base = emptyData();
          meta = { profile: { name: user.displayName || "", photo: "" }, categories: base.categories, recurring: [], budget: base.budget, settings: base.settings };
          F.setDoc(userRef, { ...meta, createdAt: F.serverTimestamp() }).catch(fail);
        } else meta = s.data();
        status = { ok: true, offline: s.metadata.fromCache };
        emit();
      }, fail));
      unsubs.push(F.onSnapshot(entriesRef, (s) => {
        for (const ch of s.docChanges()) {
          if (ch.type === "removed") entries.delete(ch.doc.id);
          else entries.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
        }
        gotEntries = true;
        emit();
      }, fail));
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
      const allowed = {};
      for (const k of ["categories", "recurring", "budget", "settings", "profile"]) if (k in patch) allowed[k] = patch[k];
      meta = { ...(meta || {}), ...allowed };
      emit();
      F.updateDoc(userRef, allowed).catch(fail);
      return true;
    },
    async replaceAll(next) {
      const n = normalise(next);
      const old = [...entries.keys()];
      await batchedWrite([
        ...old.map((id) => (b) => b.delete(F.doc(entriesRef, id))),
        ...n.entries.map((e) => (b) => b.set(F.doc(entriesRef, e.id), clean(e))),
      ]);
      await F.updateDoc(userRef, { categories: n.categories, recurring: n.recurring, budget: n.budget });
      return true;
    },
    async clear() {
      const base = emptyData();
      await batchedWrite([...entries.keys()].map((id) => (b) => b.delete(F.doc(entriesRef, id))));
      await F.updateDoc(userRef, { categories: base.categories, recurring: [], budget: base.budget });
      return true;
    },
  };
}
