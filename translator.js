// translator.js
// Groq multi-key rotáló fordítási motor + MyMemory fallback
// Behívása: import { TranslatorEngine } from './translator.js';

// ─── KONFIGURÁCIÓ ─────────────────────────────────────────────────────────────

// A Supabase Edge Function URL-je — ezt töltsd ki a saját projektedre
const EDGE_FUNCTION_URL =
  "https://yyexlblyepkxyqqbgpvu.supabase.co/functions/v1/groq-translate";

// Groq API kulcsonkénti napi limitek (Groq ingyenes tier)
const DAILY_LIMIT_PER_KEY = 1000; // kérés/nap/kulcs

// Polling intervallum (ms) — ennyivel pingelünk
const POLL_INTERVAL_MS = 30_000; // 30 másodperc

// Fallback státusz üzenetek minden nyelven
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

// ─── ÁLLAPOT ──────────────────────────────────────────────────────────────────

/**
 * @typedef {{ key: string; label: string; used: number; limit: number; exhausted: boolean; lastError: string|null }} KeySlot
 */

export class TranslatorEngine {
  constructor({ onStatusChange, onKeyUpdate, getCurrentLang }) {
    /** @type {KeySlot[]} */
    this._keys = this._loadKeys();
    this._currentKeyIndex = 0;
    this._groqAvailable = false; // konzervatívan indul — polling dönti el
    this._usingFallback = false;
    this._pollTimer = null;
    this._cache = new Map();
    this._lastResetDate = this._todayStr();
    this._onStatusChange = onStatusChange || (() => {});
    this._onKeyUpdate = onKeyUpdate || (() => {});
    this._getCurrentLang = getCurrentLang || (() => "hu");

    this._maybeResetDaily();
    this._startPolling();
  }

  // ─── PUBLIKUS API ───────────────────────────────────────────────────────────

  /** Fő fordítási belépési pont */
  async translate(text, src, tgt) {
    if (!text || src === tgt) return text;

    const cacheKey = `${src}|${tgt}|${text}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    this._maybeResetDaily();

    // Groq próba — minden elérhető kulcson végigmegy
    if (this._groqAvailable || this._keys.some((k) => !k.exhausted)) {
      const result = await this._tryGroq(text, src, tgt);
      if (result !== null) {
        this._cache.set(cacheKey, result);
        if (this._usingFallback) {
          this._usingFallback = false;
          this._groqAvailable = true;
          this._notifyStatus("restored");
          this._onKeyUpdate(this._keys);
        }
        return result;
      }
    }

    // Fallback — MyMemory
    if (!this._usingFallback) {
      this._usingFallback = true;
      this._groqAvailable = false;
      this._notifyStatus("fallback");
    }
    const fallback = await this._myMemory(text, src, tgt);
    this._cache.set(cacheKey, fallback);
    return fallback;
  }

  /** Groq elérhetőség ping (polling is ezt hívja) */
  async pingGroq() {
    const activeKey = this._getActiveKey();
    if (!activeKey) {
      this._groqAvailable = false;
      return false;
    }
    try {
      const res = await fetch(EDGE_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-key": activeKey.key,
        },
        body: JSON.stringify({ text: "ok", src: "en", tgt: "en" }),
        signal: AbortSignal.timeout(8000),
      });
      // src===tgt esetén passthrough, nem számít bele a kvótába
      const ok = res.ok || res.status === 200;
      if (ok && !this._groqAvailable) {
        this._groqAvailable = true;
        if (this._usingFallback) {
          this._usingFallback = false;
          this._notifyStatus("restored");
          this._onKeyUpdate(this._keys);
        }
      }
      this._groqAvailable = ok;
      return ok;
    } catch {
      this._groqAvailable = false;
      return false;
    }
  }

  /** Admin: kulcsok beállítása (10 slot) */
  setKeys(keysArray) {
    // keysArray: [{ key, label }] max 10 elem
    this._keys = keysArray.slice(0, 10).map((item, i) => ({
      key: item.key || "",
      label: item.label || `Kulcs #${i + 1}`,
      used: item.used ?? 0,
      limit: DAILY_LIMIT_PER_KEY,
      exhausted: (item.used ?? 0) >= DAILY_LIMIT_PER_KEY,
      lastError: null,
    }));
    this._currentKeyIndex = 0;
    this._saveKeys();
    this._onKeyUpdate(this._keys);
    // Azonnal pingel
    this.pingGroq();
  }

  /** Admin: egyetlen kulcs törlése index alapján */
  removeKey(index) {
    if (index < 0 || index >= this._keys.length) return;
    this._keys.splice(index, 1);
    this._currentKeyIndex = Math.min(
      this._currentKeyIndex,
      Math.max(0, this._keys.length - 1)
    );
    this._saveKeys();
    this._onKeyUpdate(this._keys);
  }

  /** Admin: egyetlen kulcs hozzáadása vagy frissítése */
  upsertKey(index, keyStr, label) {
    if (index < 0 || index > 9) return;
    if (!this._keys[index]) {
      this._keys[index] = {
        key: keyStr,
        label: label || `Kulcs #${index + 1}`,
        used: 0,
        limit: DAILY_LIMIT_PER_KEY,
        exhausted: false,
        lastError: null,
      };
    } else {
      this._keys[index].key = keyStr;
      this._keys[index].label = label || this._keys[index].label;
      this._keys[index].exhausted = this._keys[index].used >= DAILY_LIMIT_PER_KEY;
      this._keys[index].lastError = null;
    }
    this._saveKeys();
    this._onKeyUpdate(this._keys);
  }

  getKeys() {
    return this._keys;
  }

  isGroqAvailable() {
    return this._groqAvailable;
  }

  isUsingFallback() {
    return this._usingFallback;
  }

  destroy() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  // ─── BELSŐ LOGIKA ───────────────────────────────────────────────────────────

  async _tryGroq(text, src, tgt) {
    // Végigjárja az összes kulcsot körkörösen
    const total = this._keys.length;
    if (total === 0) return null;

    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this._currentKeyIndex + attempt) % total;
      const slot = this._keys[idx];
      if (!slot?.key || slot.exhausted) continue;

      try {
        const res = await fetch(EDGE_FUNCTION_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-groq-key": slot.key,
          },
          body: JSON.stringify({ text, src, tgt }),
          signal: AbortSignal.timeout(12000),
        });

        if (res.status === 429 || res.status === 503) {
          // Rate limit — ez a kulcs kimerült, következőre vált
          slot.exhausted = true;
          slot.lastError = "rate_limited";
          this._saveKeys();
          this._onKeyUpdate(this._keys);
          this._currentKeyIndex = (idx + 1) % total;
          continue;
        }

        if (!res.ok) {
          slot.lastError = `http_${res.status}`;
          this._saveKeys();
          this._onKeyUpdate(this._keys);
          continue;
        }

        const data = await res.json();
        if (data?.error === "all_models_failed") {
          slot.exhausted = true;
          slot.lastError = "all_models_failed";
          this._saveKeys();
          this._onKeyUpdate(this._keys);
          this._currentKeyIndex = (idx + 1) % total;
          continue;
        }

        if (data?.translated) {
          // Siker — számláló növelése
          slot.used = (slot.used || 0) + 1;
          slot.exhausted = slot.used >= slot.limit;
          slot.lastError = null;
          // Ha ez a kulcs megtelik, előre ugrik a következőre
          if (slot.exhausted) {
            this._currentKeyIndex = (idx + 1) % total;
          } else {
            this._currentKeyIndex = idx;
          }
          this._saveKeys();
          this._onKeyUpdate(this._keys);
          return data.translated;
        }
      } catch (err) {
        slot.lastError = String(err).slice(0, 60);
        this._saveKeys();
        this._onKeyUpdate(this._keys);
        // Timeout / network hiba → következő kulcs
        continue;
      }
    }

    return null; // Minden kulcs megbukott → fallback
  }

  async _myMemory(text, src, tgt) {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
        text
      )}&langpair=${src}|${tgt}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return data?.responseData?.translatedText || text;
    } catch {
      return text; // Ha minden megbukik, az eredetit adja vissza
    }
  }

  _getActiveKey() {
    for (let i = 0; i < this._keys.length; i++) {
      const idx = (this._currentKeyIndex + i) % this._keys.length;
      if (this._keys[idx]?.key && !this._keys[idx].exhausted) {
        return this._keys[idx];
      }
    }
    return null;
  }

  _startPolling() {
    // Azonnal pingelünk az indulásnál
    this.pingGroq();
    this._pollTimer = setInterval(() => {
      this.pingGroq();
      this._maybeResetDaily();
    }, POLL_INTERVAL_MS);
  }

  _notifyStatus(type) {
    const lang = this._getCurrentLang();
    const msg =
      type === "fallback"
        ? FALLBACK_MESSAGES[lang] || FALLBACK_MESSAGES.hu
        : GROQ_RESTORED_MESSAGES[lang] || GROQ_RESTORED_MESSAGES.hu;
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
        k.used = 0;
        k.exhausted = false;
        k.lastError = null;
      });
      this._currentKeyIndex = 0;
      this._saveKeys();
      this._onKeyUpdate(this._keys);
      console.log("[Translator] Napi limitekek visszaállítva:", today);
    }
  }

  _loadKeys() {
    try {
      const raw = localStorage.getItem("lt_groq_keys");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item, i) => ({
        key: item.key || "",
        label: item.label || `Kulcs #${i + 1}`,
        used: Number(item.used) || 0,
        limit: DAILY_LIMIT_PER_KEY,
        exhausted: (Number(item.used) || 0) >= DAILY_LIMIT_PER_KEY,
        lastError: item.lastError || null,
      }));
    } catch {
      return [];
    }
  }

  _saveKeys() {
    try {
      const toSave = this._keys.map((k) => ({
        key: k.key,
        label: k.label,
        used: k.used,
        lastError: k.lastError,
      }));
      localStorage.setItem("lt_groq_keys", JSON.stringify(toSave));
      // Reset dátumot is menti
      localStorage.setItem("lt_reset_date", this._lastResetDate);
    } catch (e) {
      console.warn("[Translator] localStorage mentési hiba:", e);
    }
  }
}