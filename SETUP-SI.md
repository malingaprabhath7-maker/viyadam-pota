# වියදම් පොත — Setup උපදෙස් (සිංහලෙන්)

මේ පියවර අනුපිළිවෙලින් කළොත්, විනාඩි 20–30කින් ඔයාගේ website එක online වෙලා, අනිත් අයටත් ගිණුම් හදාගෙන භාවිතා කරන්න පුළුවන් වෙනවා. සියල්ල **නොමිලේ**.

> පහත සෑම තැනකම `YOUR-USERNAME` කියන තැනට ඔයාගේ GitHub username එක දාන්න.

---

## 1. GitHub එකේ repository එකක් හදන්න

1. https://github.com එකට ගිහින් ගිණුමක් නැත්නම් **Sign up** කරන්න.
2. උඩ දකුණේ **+** → **New repository**.
3. **Repository name:** `viyadam-pota`
4. **Public** තෝරන්න (GitHub Pages නොමිලේ ලැබෙන්නේ public repo වලට).
5. "Add a README file" **tick කරන්න එපා**. → **Create repository**.

## 2. Files upload කරන්න

1. මම දුන්න `viyadam-pota.zip` එක ඔයාගේ computer එකේ **extract** (unzip) කරන්න.
2. GitHub repo පිටුවේ **"uploading an existing file"** link එක ඔබන්න (නැත්නම් **Add file → Upload files**).
3. Extract කරපු `viyadam-pota` folder එක **ඇතුළේ තියෙන සියලුම files සහ folders** (`index.html`, `css`, `js`, `icons`, `docs`, …) select කරලා browser එකට **drag & drop** කරන්න.
   - Folder එකම නෙවෙයි, ඒක ඇතුළේ තියෙන දේවල් drag කරන්න. එතකොට `index.html` repo එකේ මුල් තැනට එනවා.
   - `.gitignore`, `.nojekyll` වගේ තිතකින් පටන් ගන්න files upload නොවුණත් ප්‍රශ්නයක් නැහැ.
4. පහළ **Commit changes** ඔබන්න.

## 3. Website එක publish කරන්න (GitHub Pages)

1. Repo එකේ **Settings → Pages**.
2. **Source:** `Deploy from a branch`, **Branch:** `main`, folder `/ (root)` → **Save**.
3. විනාඩියක් දෙකක් ඉඳලා page එක refresh කරන්න. උඩින් මෙහෙම link එකක් පේනවා:
   `https://YOUR-USERNAME.github.io/viyadam-pota/`
4. ඒක open කරලා බලන්න. මේ වෙලාවේ app එක **Guest mode** එකෙන් වැඩ කරනවා (ගිණුම් තවම නැහැ).

## 4. ගිණුම් (Login / Sign up) සක්‍රිය කරන්න — Firebase

1. https://console.firebase.google.com → ඔයාගේ Google ගිණුමෙන් ඇතුළු වෙන්න.
2. **Create a project** → නම: `viyadam-pota` → Google Analytics අවශ්‍ය නැහැ (off කරන්න) → **Create**.
3. වම් පැත්තේ **Build → Authentication → Get started** → **Email/Password** → පළමු switch එක **Enable** → **Save**.
4. **Build → Firestore Database → Create database** → location එක `asia-south1 (Mumbai)` වගේ ළඟම එකක් → **Start in production mode** → **Create**.
5. Firestore එකේ **Rules** tab එකට ගිහින් තියෙන දේ මකලා, project එකේ `firestore.rules` file එකේ තියෙන සියල්ල copy කරලා paste කරන්න → **Publish**.
   - මේකෙන් තමයි එක් කෙනෙක්ගේ දත්ත තව කෙනෙක්ට බලන්න බැරි වෙන්නේ.
6. වම් උඩ ⚙️ **Project settings** → පහළට scroll කරලා **Your apps** → **`</>` (Web)** icon එක → nickname: `web` → **Register app**.
7. එතකොට පේන `firebaseConfig = { apiKey: ..., ... }` කොටස copy කරගන්න.
8. **Authentication → Settings → Authorized domains → Add domain** → `YOUR-USERNAME.github.io` → **Add**.

### Config එක GitHub එකට දාන්න

1. GitHub repo එකේ `js/firebase-config.js` file එක open කරලා ✏️ (Edit) ඔබන්න.
2. අන්තිම පේළිය `export const firebaseConfig = null;` මකලා, ඒ වෙනුවට මෙහෙම දාන්න (ඔයාගේ අගයන් එක්ක):

```js
export const firebaseConfig = {
  apiKey: "AIza....",
  authDomain: "viyadam-pota.firebaseapp.com",
  projectId: "viyadam-pota",
  storageBucket: "viyadam-pota.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123",
};
```

3. **Commit changes**. විනාඩියකින් website එකේ Login / Sign up screen එක පේනවා.

> මේ keys public වුණාට කමක් නැහැ — Firebase web apps වල ඒවා නිර්මාණය කරලා තියෙන්නේ එහෙමයි. දත්ත ආරක්ෂා කරන්නේ 5 වෙනි පියවරේ දාපු Rules වලින්.

## 5. LinkedIn preview එකට link එක හදන්න

LinkedIn, WhatsApp වල link එක share කරනකොට පින්තූරයක් සහ title එකක් පේන්න:

1. GitHub එකේ `index.html` → ✏️ Edit.
2. `YOUR-USERNAME` කියන තැන් **දෙකම** ඔයාගේ username එකට වෙනස් කරන්න → **Commit changes**.
3. `README.md` එකෙත් එහෙමම වෙනස් කරන්න (repo පිටුවේ live demo link එක හරියට පේන්න).

## 6. පරීක්ෂා කරන්න

- Website එක open කරලා **ගිණුමක් හදන්න** → නම, email, මුරපදය.
- වියදමක් දාලා, phone එකෙන් එකම email එකෙන් login වෙලා ඒක පේනවද බලන්න.
- "මුරපදය අමතකද?" email එක එනවද බලන්න (spam folder එකත් බලන්න).
- Phone එකේ browser menu → **Add to Home screen** — app එකක් වගේ install වෙනවා.

## 7. LinkedIn එකේ share කරන්න

1. https://www.linkedin.com/post-inspector/ එකට ඔයාගේ website link එක දාලා **Inspect** කරන්න — preview එක හරිද බලන්න (පස්සේ index.html වෙනස් කළොත් මෙතනින් refresh කරන්න පුළුවන්).
2. LinkedIn post එකක් හදලා link එක දාන්න. උදාහරණ post එකක්:

```
මම අලුතින් හදපු project එකක් share කරන්න කැමතියි — "වියදම් පොත" (Viyadam Pota) 💸

දිනපතා වියදම් සටහන් කරලා, සතියේ දින සහ සති අන්තයේ වියදම වෙන වෙනම බලලා,
මාසය අවසානයේ සාරාංශයක් ගන්න පුළුවන් නොමිලේ ලැබෙන web app එකක්.

✅ සිංහල & English
✅ තමන්ගේම ගිණුම (email + password), profile එක
✅ Phone & laptop අතර sync වේ, offline වැඩ කරයි (PWA)
✅ මාසික අයවැය, නැවත එන වියදම්, CSV/PDF වාර්තා

Built with: JavaScript (ES modules), Firebase Auth & Firestore, PWA, GitHub Pages

🔗 Try it: https://YOUR-USERNAME.github.io/viyadam-pota/
💻 Code: https://github.com/YOUR-USERNAME/viyadam-pota

#WebDevelopment #JavaScript #Firebase #PWA #SriLanka
```

3. ඔයාගේ LinkedIn profile එකේ **Add section → Recommended → Add featured → Add a link** හරහා website එක "Featured" එකටත් දාන්න පුළුවන්. **Projects** කොටසටත් එකතු කරන්න.

## පස්සේ වෙනස්කම් කරන්න ඕන නම්

GitHub එකේ ඕනම file එකක් ✏️ Edit කරලා **Commit** කළාම විනාඩියකින් website එක update වෙනවා. App එක install කරලා තියෙන අයට ඊළඟ වතාවේ open කරනකොට අලුත් version එක ලැබෙනවා.

## ගැටලු

| ගැටලුව | විසඳුම |
|---|---|
| Website එකේ 404 පේනවා | `index.html` repo එකේ මුල් තැනේද කියලා බලන්න (folder එකක් ඇතුළේ නෙවෙයි). Pages settings එකේ `main` / `root` තෝරලාද බලන්න. |
| Login කරනකොට "යමක් වැරදුණා" | Firebase **Authorized domains** එකට `YOUR-USERNAME.github.io` දාලාද, Email/Password enable කරලාද බලන්න. |
| දත්ත save වෙන්නේ නැහැ | Firestore **Rules** publish කරලාද බලන්න. |
| පරණ version එක පේනවා | Page එක දෙපාරක් refresh කරන්න (app එක offline cache එකක් පාවිච්චි කරනවා). |
