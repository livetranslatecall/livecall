# Élő Fordító Hívás — beüzemelési útmutató

## Mit tartalmaz a csomag
- `index.html` — a teljes app (UI + WebRTC + Supabase + beszédfelismerés + fordítás)
- `manifest.json` — PWA telepíthetőség
- `sw.js` — service worker
- `icon-192.png`, `icon-512.png` — app ikonok

## 1. lépés — Supabase projekt (ingyenes)
1. Regisztrálj a https://supabase.com oldalon, hozz létre egy új projektet (ingyenes csomag).
2. A projekt Dashboardján: **Project Settings → API**.
3. Másold ki a **Project URL**-t és az **anon public** kulcsot.
4. Nyisd meg az `index.html`-t, és az elején keresd meg ezt a részt:
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
   ```
   Írd be ide a saját adataidat.
5. A Dashboardon: **Database → Realtime** (vagy Project Settings → Realtime) — győződj meg róla, hogy a Realtime **be van kapcsolva** (alapból az). Nincs szükség táblára, mert az app a Supabase Realtime *Broadcast* és *Presence* funkcióit használja, adatbázis nélkül.

## 2. lépés — Ingyenes hosztolás (HTTPS kötelező a kamerához/mikrofonhoz)
Bármelyik ingyenes statikus hoszting jó, pl.:
- **Netlify** (drag & drop a mappát a app.netlify.com oldalra), vagy
- **Vercel** (`vercel.com` → New Project → mappa feltöltése), vagy
- **GitHub Pages** (repo → Settings → Pages).

Töltsd fel mind a 4 fájlt (index.html, manifest.json, sw.js, ikonok) egy mappába, és publikáld. Kapsz egy `https://valami.netlify.app` jellegű linket.

## 3. lépés — Kipróbálás
1. Nyisd meg a linket telefonon és laptopon (vagy két telefonon).
2. Az egyik fél: válassza ki a nyelvét → **"Új hívás indítása"** → megjelenik egy 6 jegyű kód.
3. Küldd el a kódot a másik félnek (SMS, Messenger, bármi).
4. A másik fél: válassza ki a saját nyelvét → írja be a kódot → **"Csatlakozás kóddal"**.
5. Pár másodperc múlva összeáll a videóhívás, és elindul az élő felirat-fordítás.

## Mit érdemes tudni
- **Böngésző**: Chrome vagy Edge ajánlott (a beszédfelismeréshez). iPhone-on Safari-ban is működik a hívás és a chat, de a beszédfelismerés kevésbé stabil — ilyenkor a beépített 💬 chat gombbal lehet írásban kommunikálni, az is automatikusan fordít.
- **TURN szerver**: a csomagban egy ingyenes, nyilvános teszt-TURN szerver van beállítva (openrelay.metered.ca). Ez korlátozott kapacitású; ha gyakran nem jön létre a kapcsolat mobilneten, érdemes ingyenes saját fiókot regisztrálni a metered.ca oldalon, és a kapott saját TURN adatokkal lecserélni az `ICE_SERVERS` listát az `index.html` elején.
- **Fordítás**: a MyMemory ingyenes API-t használja, napi karakterlimittel — normál beszélgetéshez bőven elég, csak nagyon intenzív, egész napos használatnál futhat bele limitbe.
- **Supabase ingyenes csomag**: 7 nap teljes inaktivitás után "elalszik" a projekt. Ha ritkán használjátok, néha nyisd meg a linket, hogy ébren tartsd, vagy állíts be egy ingyenes automatikus "ping"-et (pl. GitHub Actions cron job, ami hetente lekéri a Supabase URL-t).
- **Telefon-telefon és telefon-laptop** kombináció egyaránt működik, mert az egész rendszer böngészőben fut (nincs natív app-hoz kötve), és a WebRTC/Supabase platformfüggetlen.

## Ha valami nem működik
- Ellenőrizd, hogy a böngésző engedélyezte-e a kamera/mikrofon hozzáférést (első betöltéskor rá kell kattintani az engedélyre).
- Ellenőrizd, hogy a `SUPABASE_URL` / `SUPABASE_ANON_KEY` helyesen van-e kitöltve.
- Nyisd meg a böngésző fejlesztői konzolját (F12 → Console) — ott minden hiba kiírásra kerül magyarul kommentezve.
