// translator.js
// Groq multi-key rotáló fordítási motor + MyMemory fallback
// Behívása: import { TranslatorEngine } from './translator.js';

// ─── KONFIGURÁCIÓ ─────────────────────────────────────────────────────────────

const EDGE_FUNCTION_URL =
  "https://yyexlblyepkxyqqbgpvu.supabase.co/functions/v1/groq-translate";

const DAILY_LIMIT_PER_KEY = 1000;
const POLL_INTERVAL_MS    = 30_000;
const SAVE_DEBOUNCE_MS    = 3_000;
const MAX_CACHE_SIZE      = 500;

const FALLBACK_MESSAGES = {
  hu: "⚠️ Groq fordítás átmenetileg nem elérhető – gyengébb minőségű fordításra váltottunk. A rendszer folyamatosan próbál visszakapcsolni.",
  en: "⚠️ Groq translation temporarily unavailable – switched to lower quality fallback. The system keeps retrying.",
  ru: "⚠️ Перевод Groq временно недоступен – переключились на запасной вариант. Система продолжает попытки восстановления.",
};

const GROQ_RESTORED_MESSAGES = {
  hu: "✅ Groq fordítás visszaállt – kiváló minőségű fordítás aktív.",
  en: "✅ Groq translation restored – high quality translation active.",
  ru: "✅ Перевод Groq восстановлен – высококачественный перевод активен.",
};

// ─── FŐ OSZTÁLY ───────────────────────────────────────────────────────────────

class TranslatorEngine {
  constructor({ onStatusChange, onKeyUpdate, getCurrentLang }) {
    /** @type {Array<{key:string,label:string,used:number,limit:number,exhausted:boolean,lastError:string|null}>} */
    this._keys             = [];
    this._currentKeyIndex  = 0;
    this._groqAvailable    = false;
    this._usingFallback    = false;
    this._pollTimer        = null;
    this._syncTimer        = null;
    this._cache            = new Map();
    this._lastResetDate    = this._todayStr();
    this._onStatusChange   = onStatusChange || (() => {});
    this._onKeyUpdate      = onKeyUpdate    || (() => {});
    this._getCurrentLang   = getCurrentLang || (() => "hu");
    this._initialized      = false;

    console.log("[Translator] Motor inicializálása...");
    this._initKeys();
  }

  // ─── PUBLIKUS API ────────────────────────────────────────────────────────────

async translate(text, src, tgt) {
    if (!text || !text.trim()) return text;
    if (src === tgt) return text;

    // Várunk az inicializálásra (max 5 mp)
    if (!this._initialized) {
      await this._waitForInit(5000);
    }

    const cacheKey = `${src}|${tgt}|${text.trim()}`;
    console.log("[Cache] translate hívás:", src, "→", tgt, "szöveg:", text.slice(0,20));
    const cached = this._getCache(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    this._maybeResetDaily();

    // Groq próba
    const activeKeys = this._keys.filter(k => k.key && !k.exhausted);
    if (activeKeys.length > 0) {
      const result = await this._tryGroq(text, src, tgt);
      if (result !== null) {
        this._setCache(cacheKey, result);
        if (this._usingFallback) {
          this._usingFallback = false;
          this._groqAvailable = true;
          this._notifyStatus("restored");
          this._onKeyUpdate(this._keys);
        }
        return result;
      }
    }

    // MyMemory fallback
    if (!this._usingFallback) {
      this._usingFallback = true;
      this._groqAvailable = false;
      this._notifyStatus("fallback");
      console.warn("[Translator] Groq nem elérhető, MyMemory fallback aktív.");
    }

    const fallback = await this._myMemory(text, src, tgt);
    this._setCache(cacheKey, fallback);
    return fallback;
  }


  async pingGroq() {
    const activeKey = this._getActiveKey();
    if (!activeKey) {
      console.warn("[Translator] Ping: nincs aktív kulcs.");
      this._groqAvailable = false;
      return false;
    }

    try {
      const res = await fetch(EDGE_FUNCTION_URL, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-key":   activeKey.key,
        },
        body:   JSON.stringify({ text: "ok", src: "en", tgt: "en" }),
        signal: AbortSignal.timeout(8000),
      });

      const ok = res.ok || res.status === 200;
      if (ok && !this._groqAvailable) {
        this._groqAvailable = true;
        if (this._usingFallback) {
          this._usingFallback = false;
          this._notifyStatus("restored");
          this._onKeyUpdate(this._keys);
        }
        console.log("[Translator] Ping: Groq elérhető ✅");
      } else if (!ok) {
        console.warn("[Translator] Ping: Groq nem válaszolt rendesen, státusz:", res.status);
      }
      this._groqAvailable = ok;
      return ok;
    } catch (e) {
      console.warn("[Translator] Ping hiba:", e.message || e);
      this._groqAvailable = false;
      return false;
    }
  }

  async setKeys(keysArray) {
    this._keys = keysArray.slice(0, 10).map((item, i) => ({
      key:       item.key   || "",
      label:     item.label || `Kulcs #${i + 1}`,
      used:      item.used  ?? 0,
      limit:     DAILY_LIMIT_PER_KEY,
      exhausted: (item.used ?? 0) >= DAILY_LIMIT_PER_KEY,
      lastError: null,
    }));
    this._currentKeyIndex = 0;
    await this._saveKeys();
    this._onKeyUpdate(this._keys);
    this.pingGroq();
    console.log("[Translator] Kulcsok beállítva:", this._keys.filter(k => k.key).length, "aktív db");
  }

  async removeKey(index) {
    if (index < 0 || index >= this._keys.length) return;
    this._keys.splice(index, 1);
    this._currentKeyIndex = Math.min(
      this._currentKeyIndex,
      Math.max(0, this._keys.length - 1)
    );
    await this._saveKeys();
    this._onKeyUpdate(this._keys);
    console.log("[Translator] Kulcs törölve, index:", index);
  }

  async upsertKey(index, keyStr, label) {
    if (index < 0 || index > 9) return;
    if (!this._keys[index]) {
      this._keys[index] = {
        key:       keyStr,
        label:     label || `Kulcs #${index + 1}`,
        used:      0,
        limit:     DAILY_LIMIT_PER_KEY,
        exhausted: false,
        lastError: null,
      };
    } else {
      this._keys[index].key       = keyStr;
      this._keys[index].label     = label || this._keys[index].label;
      this._keys[index].exhausted = this._keys[index].used >= DAILY_LIMIT_PER_KEY;
      this._keys[index].lastError = null;
    }
    await this._saveKeys();
    this._onKeyUpdate(this._keys);
    console.log("[Translator] Kulcs upsert, index:", index, "label:", label);
  }

  getKeys()           { return this._keys; }
  isGroqAvailable()   { return this._groqAvailable; }
  isUsingFallback()   { return this._usingFallback; }

  destroy() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._syncTimer) clearTimeout(this._syncTimer);
    console.log("[Translator] Motor leállítva.");
  }

  // ─── INICIALIZÁLÁS ───────────────────────────────────────────────────────────

  async _initKeys() {
    try {
      this._keys = await this._loadKeys();
      this._maybeResetDaily();
      console.log(
        "[Translator] Inicializálás kész.",
        this._keys.filter(k => k.key).length, "kulcs betöltve."
      );
    } catch (e) {
      console.error("[Translator] Inicializálási hiba:", e);
      this._keys = [];
    } finally {
      this._initialized = true;
      this._startPolling();
    }
  }

  _waitForInit(timeoutMs) {
    return new Promise((resolve) => {
      const start    = Date.now();
      const interval = setInterval(() => {
        if (this._initialized || Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });
  }

  // ─── GROQ FORDÍTÁS ───────────────────────────────────────────────────────────

  async _tryGroq(text, src, tgt) {
    const total = this._keys.length;
    if (total === 0) return null;

    for (let attempt = 0; attempt < total; attempt++) {
      const idx  = (this._currentKeyIndex + attempt) % total;
      const slot = this._keys[idx];

      if (!slot?.key || slot.exhausted) continue;

      try {
        console.log(
          `[Translator] Groq kísérlet: kulcs #${idx + 1} (${slot.label}),`,
          `felhasználva: ${slot.used}/${slot.limit}`
        );

        const res = await fetch(EDGE_FUNCTION_URL, {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            "x-groq-key":   slot.key,
          },
          body:   JSON.stringify({ text, src, tgt }),
          signal: AbortSignal.timeout(12000),
        });

        // Rate limit vagy szerver túlterhelt
        if (res.status === 429 || res.status === 503) {
          console.warn(`[Translator] Kulcs #${idx + 1} rate limit (${res.status}), következő kulcsra vált.`);
          slot.exhausted  = true;
          slot.lastError  = `rate_limited_${res.status}`;
          await this._saveKeys();
          this._onKeyUpdate(this._keys);
          this._currentKeyIndex = (idx + 1) % total;
          continue;
        }

        // Egyéb HTTP hiba
        if (!res.ok) {
          console.warn(`[Translator] Kulcs #${idx + 1} HTTP hiba: ${res.status}`);
          slot.lastError = `http_${res.status}`;
          await this._saveKeys();
          this._onKeyUpdate(this._keys);
          continue;
        }

        const data = await res.json();

        // Edge function visszajelzése: minden modell megbukott
        if (data?.error === "all_models_failed") {
          console.warn(`[Translator] Kulcs #${idx + 1}: all_models_failed.`);
          slot.exhausted  = true;
          slot.lastError  = "all_models_failed";
          await this._saveKeys();
          this._onKeyUpdate(this._keys);
          this._currentKeyIndex = (idx + 1) % total;
          continue;
        }

        // Sikeres fordítás
        if (data?.translated) {
          slot.used      = (slot.used || 0) + 1;
          slot.exhausted = slot.used >= slot.limit;
          slot.lastError = null;

          if (slot.exhausted) {
            console.warn(`[Translator] Kulcs #${idx + 1} kimerült (${slot.used}/${slot.limit}), következőre vált.`);
            this._currentKeyIndex = (idx + 1) % total;
          } else {
            this._currentKeyIndex = idx;
          }

          await this._saveKeys();
          this._scheduleSyncToSupabase();
          this._onKeyUpdate(this._keys);
          return data.translated;
        }

        console.warn(`[Translator] Kulcs #${idx + 1}: váratlan válasz:`, data);

      } catch (err) {
        const msg = err?.name === "TimeoutError"
          ? "timeout"
          : (String(err).slice(0, 80));
        console.warn(`[Translator] Kulcs #${idx + 1} hiba:`, msg);
        slot.lastError = msg;
        await this._saveKeys();
        this._onKeyUpdate(this._keys);
        continue;
      }
    }

    console.error("[Translator] Minden Groq kulcs megbukott, fallbackre vált.");
    return null;
  }

  // ─── MYMEMORY FALLBACK ───────────────────────────────────────────────────────

  async _myMemory(text, src, tgt) {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const result = data?.responseData?.translatedText;
      if (!result) throw new Error("Üres válasz");
      return result;
    } catch (e) {
      console.warn("[Translator] MyMemory hiba:", e.message || e, "— eredeti szöveg visszaadva.");
      return text;
    }
  }

  // ─── BETÖLTÉS ────────────────────────────────────────────────────────────────

  async _loadKeys() {
    const client = window.supabaseClient;

    // 1. Supabase próba
    if (client) {
      try {
        console.log("[Translator] Kulcsok betöltése Supabase-ből...");
        const { data, error } = await client
  .from("groq_keys")
  .select("keys, reset_date")
  .eq("id", 1)
  .single();

        if (error) throw error;

        if (data?.keys && Array.isArray(data.keys) && data.keys.length > 0) {

          const today = this._todayStr();
if (data.reset_date !== today) {
  console.log("[Translator] Supabase reset_date régi, napi reset szükséges...");
  data.keys.forEach(k => {
    k.used      = 0;
    k.lastError = null;
  });
  this._lastResetDate = today;
  await client
    .from("groq_keys")
    .update({ reset_date: today })
    .eq("id", 1);
}
          console.log("[Translator] ✅ Supabase betöltés sikeres:", data.keys.filter(k => k.key).length, "kulcs.");
          return data.keys.map((item, i) => ({
            key:       item.key       || "",
            label:     item.label     || `Kulcs #${i + 1}`,
            used:      Number(item.used) || 0,
            limit:     DAILY_LIMIT_PER_KEY,
            exhausted: (Number(item.used) || 0) >= DAILY_LIMIT_PER_KEY,
            lastError: item.lastError || null,
          }));
        }

        console.log("[Translator] Supabase üres, localStorage próba...");
      } catch (e) {
        console.warn("[Translator] Supabase betöltés hiba:", e?.message || e);
      }
    } else {
      console.warn("[Translator] window.supabaseClient nem elérhető, localStorage próba...");
    }

    // 2. localStorage fallback
    try {
      const raw = localStorage.getItem("lt_groq_keys");
      if (!raw) {
        console.log("[Translator] localStorage is üres, 0 kulcs.");
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      console.log("[Translator] ✅ localStorage betöltés sikeres:", parsed.filter(k => k.key).length, "kulcs.");
      return parsed.map((item, i) => ({
        key:       item.key       || "",
        label:     item.label     || `Kulcs #${i + 1}`,
        used:      Number(item.used) || 0,
        limit:     DAILY_LIMIT_PER_KEY,
        exhausted: (Number(item.used) || 0) >= DAILY_LIMIT_PER_KEY,
        lastError: item.lastError || null,
      }));
    } catch (e) {
      console.error("[Translator] localStorage parse hiba:", e);
      return [];
    }
  }

  // ─── MENTÉS ──────────────────────────────────────────────────────────────────

  async _saveKeys() {
    const toSave = this._keys.map((k) => ({
      key:       k.key,
      label:     k.label,
      used:      k.used,
      lastError: k.lastError,
    }));

    // 1. LocalStorage — mindig, azonnal
    try {
      localStorage.setItem("lt_groq_keys",  JSON.stringify(toSave));
      localStorage.setItem("lt_reset_date", this._lastResetDate);
    } catch (e) {
      console.warn("[Translator] localStorage mentési hiba:", e);
    }
  }

  // Supabase mentés debounce-olva (ne írjon fordításonként)
  _scheduleSyncToSupabase() {
    const client = window.supabaseClient;
    if (!client) return;

    if (this._syncTimer) clearTimeout(this._syncTimer);

    this._syncTimer = setTimeout(async () => {
      const toSave = this._keys.map((k) => ({
        key:       k.key,
        label:     k.label,
        used:      k.used,
        lastError: k.lastError,
      }));

      try {
        console.log("[Translator] Supabase szinkron indul (RPC)...");
        const { error } = await client.rpc("save_groq_keys", {
          admin_token: "LiveCall2026Admin",
          keys_data:   toSave,
        });

        if (error) throw error;
        console.log("[Translator] ✅ Supabase szinkron sikeres (RPC).");
      } catch (e) {
        console.warn("[Translator] Supabase szinkron hiba:", e?.message || e);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // ─── POLLING ─────────────────────────────────────────────────────────────────

  _startPolling() {
    this.pingGroq();
    this._pollTimer = setInterval(() => {
      this._maybeResetDaily();
      this.pingGroq();
    }, POLL_INTERVAL_MS);
    console.log("[Translator] Polling elindítva, intervallum:", POLL_INTERVAL_MS / 1000, "mp");
  }

  // ─── SEGÉDFÜGGVÉNYEK ─────────────────────────────────────────────────────────

  _getActiveKey() {
    const total = this._keys.length;
    for (let i = 0; i < total; i++) {
      const idx  = (this._currentKeyIndex + i) % total;
      const slot = this._keys[idx];
      if (slot?.key && !slot.exhausted) return slot;
    }
    return null;
  }

  _notifyStatus(type) {
    const lang = this._getCurrentLang();
    const msg  = type === "fallback"
      ? (FALLBACK_MESSAGES[lang]        || FALLBACK_MESSAGES.hu)
      : (GROQ_RESTORED_MESSAGES[lang]   || GROQ_RESTORED_MESSAGES.hu);
    this._onStatusChange({ type, message: msg });
  }

  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  _maybeResetDaily() {
    const today = this._todayStr();
    if (this._lastResetDate !== today) {
      this._lastResetDate = today;
      this._keys.forEach((k) => {
        k.used      = 0;
        k.exhausted = false;
        k.lastError = null;
      });
      this._currentKeyIndex = 0;
      this._saveKeys();
      this._syncResetDateToSupabase(today);
      this._onKeyUpdate(this._keys);
      console.log("[Translator] ✅ Napi limitek visszaállítva:", today);
    }
  }

  async _syncResetDateToSupabase(date) {
    const client = window.supabaseClient;
    if (!client) return;
    try {
      const { error } = await client
        .from("groq_keys")
        .update({ reset_date: date })
        .eq("id", 1);
      if (error) throw error;
      console.log("[Translator] ✅ reset_date szinkronizálva Supabase-be:", date);
    } catch (e) {
      console.warn("[Translator] reset_date sync hiba:", e?.message || e);
    }
  }

  _setCache(key, value) {
  // Memória cache
  if (this._cache.size >= MAX_CACHE_SIZE) {
    const firstKey = this._cache.keys().next().value;
    this._cache.delete(firstKey);
  }
  this._cache.set(key, value);

  // localStorage cache
  try {
    const raw = localStorage.getItem("lt_translate_cache");
    const obj = raw ? JSON.parse(raw) : {};
    const keys = Object.keys(obj);
    // Ha tele van, töröljük a legrégebbiek felét
    if (keys.length >= MAX_CACHE_SIZE) {
      keys.slice(0, Math.floor(MAX_CACHE_SIZE / 2)).forEach(k => delete obj[k]);
    }
    obj[key] = value;
    localStorage.setItem("lt_translate_cache", JSON.stringify(obj));
    console.log("[Cache] Írás sikeres, kulcsok száma:", Object.keys(obj).length);
  } catch(e) {
    // localStorage tele vagy nem elérhető — csak memória cache marad
    console.warn("[Translator] localStorage cache írási hiba:", e);
  }
}

_getCache(key) {
    if (this._cache.has(key)) {
      return this._cache.get(key);
    }
    try {
      const raw = localStorage.getItem("lt_translate_cache");
      if (!raw) return undefined;
      const obj = JSON.parse(raw);
      if (obj[key] !== undefined) {
        this._cache.set(key, obj[key]);
        return obj[key];
      }
    } catch(e) {
      console.warn("[Translator] localStorage cache olvasási hiba:", e);
    }
    return undefined;
  }

}

window.TranslatorEngine = TranslatorEngine;
