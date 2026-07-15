// livecall-sdk.js
// LiveTranslate Call — SDK
// Minden új funkció egy helyen — globális osztályok, nincs ES modul import/export

// ═══════════════════════════════════════════════════════════════
// 1. LIVEKIT SZOBAKEZELÉS + AUTOMATIKUS ÚJRACSATLAKOZÁS
// ═══════════════════════════════════════════════════════════════


window.LIVECALL_CONFIG = window.LIVECALL_CONFIG || {
  livekitUrl:     "wss://videolive-d0o40xt9.livekit.cloud",
  supabaseUrl:    "https://yyexlblyepkxyqqbgpvu.supabase.co",
  supabaseAnonKey: "",
};


class RoomManager {
  constructor(supabaseClient, onRemoteStream, onParticipantUpdate) {
    this._sb               = supabaseClient;
    this._room             = null;
    this._onRemoteStream   = onRemoteStream   || (() => {});
    this._onParticipantUpdate = onParticipantUpdate || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnect     = 10;
    this._reconnectTimer   = null;
    this._roomName         = "";
    this._token            = "";
    this._localStream      = null;
    this._connected        = false;
    this._destroyed        = false;
  }

  async connect(roomName, token, localStream) {
    this._roomName    = roomName;
    this._token       = token;
    this._localStream = localStream;
    await this._doConnect();
  }

async _doConnect() {
    if (this._destroyed) return;
    try {
      this._room = new LivekitClient.Room({
        adaptiveStream: true,
        dynacast:       true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
        videoCaptureDefaults: {
          resolution: LivekitClient.VideoPresets.h720.resolution,
        },
        publishDefaults: {
          simulcast: true,
          videoSimulcastLayers: [
            LivekitClient.VideoPresets.h180,
            LivekitClient.VideoPresets.h360,
            LivekitClient.VideoPresets.h720,
          ],
          dtx:          true,
          audioBitrate: 32000,
          stopMicTrackOnMute: false,
        },
      });

      this._bindEvents();

      await this._room.connect(
  (window.LIVECALL_CONFIG && window.LIVECALL_CONFIG.livekitUrl) || "wss://videolive-d0o40xt9.livekit.cloud",
  this._token
);

      this._connected         = true;
      this._reconnectAttempts = 0;

      if (this._localStream) {
        for (const track of this._localStream.getTracks()) {
          await this._room.localParticipant.publishTrack(track, {
            source: track.kind === "audio"
              ? LivekitClient.Track.Source.Microphone
              : LivekitClient.Track.Source.Camera,
          }).catch(e => {
            console.warn("[RoomManager] track publish hiba:", e.message);
          });
        }
      }

      console.log("[RoomManager] ✅ Kapcsolódva:", this._roomName);
    } catch (e) {
      console.error("[RoomManager] Kapcsolódási hiba:", e.message);
      this._connected = false;
      this._scheduleReconnect();
    }
  }


_bindEvents() {
    const r = this._room;

    r.on("disconnected", (reason) => {
      console.warn("[RoomManager] Kapcsolat megszakadt:", reason);
      this._connected = false;
      if (!this._destroyed) this._scheduleReconnect();
    });

    r.on("reconnecting", () => {
      console.log("[RoomManager] Újracsatlakozás folyamatban...");
    });

    r.on("reconnected", () => {
      console.log("[RoomManager] ✅ Újracsatlakozva!");
      this._connected         = true;
      this._reconnectAttempts = 0;
    });

    r.on("trackSubscribed", (track, publication, participant) => {
      if (!track.mediaStreamTrack) {
        console.warn("[RoomManager] trackSubscribed: nincs mediaStreamTrack, skip.");
        return;
      }
      const stream = new MediaStream([track.mediaStreamTrack]);
      this._onRemoteStream(stream, track.kind, participant.identity);

      if (track.kind === "audio") {
        const audio = document.createElement("audio");
        audio.srcObject  = stream;
        audio.autoplay   = true;
        audio.style.display = "none";
        document.body.appendChild(audio);
        // Autoplay policy kezelés
        audio.play().catch(e => {
          console.warn("[RoomManager] Audio autoplay blokkolva:", e.message);
        });
      }
    });

    r.on("participantConnected", (p) => {
      console.log("[RoomManager] Résztvevő csatlakozott:", p.identity);
      this._onParticipantUpdate("join", p.identity, p.metadata);
    });

    r.on("participantDisconnected", (p) => {
      console.log("[RoomManager] Résztvevő kilépett:", p.identity);
      this._onParticipantUpdate("leave", p.identity, null);
    });

    r.on("connectionQualityChanged", (quality, participant) => {
      console.log("[RoomManager] Kapcsolat minőség:", quality, participant?.identity);
    });

    r.on("audioPlaybackStatusChanged", () => {
      if (!r.canPlaybackAudio) {
        console.warn("[RoomManager] Audio lejátszás blokkolva, felhasználói interakció szükséges.");
      }
    });
  }


  _scheduleReconnect() {
    if (this._destroyed) return;
    if (this._reconnectAttempts >= this._maxReconnect) {
      console.error("[RoomManager] Max újracsatlakozási kísérlet elérve.");
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    console.log(`[RoomManager] Újracsatlakozás ${delay}ms múlva... (${this._reconnectAttempts}/${this._maxReconnect})`);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._doConnect(), delay);
  }

  async updateLocalStream(stream) {
    this._localStream = stream;
    if (!this._room || !this._connected) return;
    for (const track of stream.getTracks()) {
      await this._room.localParticipant.publishTrack(track).catch(() => {});
    }
  }

  setVideoQuality(quality) {
    if (!this._room) return;
    this._room.remoteParticipants.forEach(p => {
      p.videoTracks.forEach(pub => {
        if (quality === "low")    pub.setVideoQuality(LivekitClient.VideoQuality.LOW);
        if (quality === "medium") pub.setVideoQuality(LivekitClient.VideoQuality.MEDIUM);
        if (quality === "high")   pub.setVideoQuality(LivekitClient.VideoQuality.HIGH);
      });
    });
  }

  async disconnect() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    if (this._room) {
      try { await this._room.disconnect(); } catch (_) {}
      this._room = null;
    }
    this._connected = false;
    console.log("[RoomManager] Lecsatlakozva.");
  }

  getRoom()     { return this._room; }
  isConnected() { return this._connected; }
}


// ═══════════════════════════════════════════════════════════════
// 2. ADAPTÍV BITRÁTA + KÉPMINŐSÉG AUTOMATIKUS CSÖKKENTÉSE
// ═══════════════════════════════════════════════════════════════

class NetworkAdaptation {
  constructor(getRoomFn) {
    this._getRoom   = getRoomFn;
    this._interval  = null;
    this._lastRtt   = 0;
    this._badStreak = 0;
    this._onQuality = null;
  }

  start(onQualityChange) {
    this._onQuality = onQualityChange || (() => {});
    this._interval  = setInterval(() => this._check(), 3000);
    console.log("[NetworkAdaptation] Elindítva.");
  }

async _check() {
    const room = this._getRoom();
    if (!room) return;

    let rtt = null;
    try {
      // LiveKit v2: a szoba publisher PC-jén keresztül érjük el a statsot
      const engine = room.engine;
      if (!engine) return;

      const pc = engine.publisher?.pc || engine.subscriberPrimary;
      if (!pc || typeof pc.getStats !== "function") return;

      const stats = await pc.getStats();
      stats.forEach(r => {
        if (
          r.type === "candidate-pair" &&
          r.state === "succeeded" &&
          r.currentRoundTripTime != null
        ) {
          rtt = Math.round(r.currentRoundTripTime * 1000);
        }
      });
    } catch (e) {
      console.warn("[NetworkAdaptation] getStats hiba:", e.message);
      return;
    }

    if (rtt === null) return;
    this._lastRtt = rtt;

    if (rtt > 400) {
      this._badStreak++;
      if (this._badStreak >= 2) {
        this._applyLowQuality();
        this._onQuality("bad", rtt);
      }
    } else if (rtt > 200) {
      this._badStreak = Math.max(0, this._badStreak - 1);
      this._applyMediumQuality();
      this._onQuality("warn", rtt);
    } else {
      this._badStreak = 0;
      this._applyHighQuality();
      this._onQuality("good", rtt);
    }
  }


_applyLowQuality() {
    const room = this._getRoom();
    if (!room) return;
    try {
      room.localParticipant?.videoTrackPublications?.forEach(pub => {
        pub.track?.sender?.setParameters?.({
          encodings: [{ maxBitrate: 100000, scaleResolutionDownBy: 4 }]
        }).catch(() => {});
      });
      console.log("[NetworkAdaptation] Alacsony minőség alkalmazva.");
    } catch (e) {
      console.warn("[NetworkAdaptation] _applyLowQuality hiba:", e.message);
    }
  }

  _applyMediumQuality() {
    const room = this._getRoom();
    if (!room) return;
    try {
      room.localParticipant?.videoTrackPublications?.forEach(pub => {
        pub.track?.sender?.setParameters?.({
          encodings: [{ maxBitrate: 300000, scaleResolutionDownBy: 2 }]
        }).catch(() => {});
      });
    } catch (e) {
      console.warn("[NetworkAdaptation] _applyMediumQuality hiba:", e.message);
    }
  }

  _applyHighQuality() {
    const room = this._getRoom();
    if (!room) return;
    try {
      room.localParticipant?.videoTrackPublications?.forEach(pub => {
        pub.track?.sender?.setParameters?.({
          encodings: [{ maxBitrate: 1500000, scaleResolutionDownBy: 1 }]
        }).catch(() => {});
      });
    } catch (e) {
      console.warn("[NetworkAdaptation] _applyHighQuality hiba:", e.message);
    }
  }



  stop() {
    clearInterval(this._interval);
    this._interval = null;
    console.log("[NetworkAdaptation] Leállítva.");
  }

  getRtt() { return this._lastRtt; }
}


// ═══════════════════════════════════════════════════════════════
// 3. HÁTTÉRZAJ SZŰRÉS — Web Audio API alapon (ingyenes)
// ═══════════════════════════════════════════════════════════════

class NoiseCancellation {
  constructor() {
    this._audioCtx     = null;
    this._sourceNode   = null;
    this._outputStream = null;
    this._active       = false;
  }

  async init(inputStream) {
    try {
      this._audioCtx   = new AudioContext({ sampleRate: 48000 });
      this._sourceNode = this._audioCtx.createMediaStreamSource(inputStream);

      const highpass = this._audioCtx.createBiquadFilter();
      highpass.type  = "highpass";
      highpass.frequency.value = 120;

      const compressor = this._audioCtx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-50, this._audioCtx.currentTime);
      compressor.knee.setValueAtTime(40,      this._audioCtx.currentTime);
      compressor.ratio.setValueAtTime(12,     this._audioCtx.currentTime);
      compressor.attack.setValueAtTime(0,     this._audioCtx.currentTime);
      compressor.release.setValueAtTime(0.25, this._audioCtx.currentTime);

      const dest = this._audioCtx.createMediaStreamDestination();
      this._sourceNode.connect(highpass);
      highpass.connect(compressor);
      compressor.connect(dest);

      this._outputStream = dest.stream;
      this._active       = true;
      console.log("[NoiseCancellation] ✅ Zajszűrő aktív.");
      return this._outputStream;
    } catch (e) {
      console.warn("[NoiseCancellation] Hiba:", e.message);
      return inputStream;
    }
  }

  isActive()        { return this._active; }
  getOutputStream() { return this._outputStream; }

  destroy() {
    try {
      this._sourceNode?.disconnect();
      this._audioCtx?.close();
    } catch (_) {}
    this._active = false;
    console.log("[NoiseCancellation] Leállítva.");
  }
}


// ═══════════════════════════════════════════════════════════════
// 4. ÁTIRATOK EXPORTÁLÁSA — PDF, Word, SRT, TXT
// ═══════════════════════════════════════════════════════════════

class TranscriptExporter {
  constructor() {
    this._entries   = [];
    this._startTime = Date.now();
  }

  addEntry(text, speaker, lang, isOwn) {
    this._entries.push({
      time:    Date.now(),
      elapsed: Date.now() - this._startTime,
      text:    text.trim(),
      speaker: speaker || (isOwn ? "Te" : "Partner"),
      lang:    lang || "hu",
      isOwn:   isOwn,
    });
  }

  clear() {
    this._entries   = [];
    this._startTime = Date.now();
  }

  exportSRT() {
    if (this._entries.length === 0) return;
    let srt = "";
    this._entries.forEach((e, i) => {
      const start = this._msToSrt(e.elapsed);
      const end   = this._msToSrt(e.elapsed + 3000);
      srt += `${i + 1}\n${start} --> ${end}\n[${e.speaker}] ${e.text}\n\n`;
    });
    this._download(srt, "atiratok.srt", "text/plain");
  }

  _msToSrt(ms) {
    const h   = Math.floor(ms / 3600000);
    const m   = Math.floor((ms % 3600000) / 60000);
    const s   = Math.floor((ms % 60000) / 1000);
    const ms2 = ms % 1000;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms2).padStart(3,"0")}`;
  }

  exportTXT() {
    if (this._entries.length === 0) return;
    const lines = this._entries.map(e => {
      const t = new Date(e.time).toLocaleTimeString([], {
        hour:"2-digit", minute:"2-digit", second:"2-digit"
      });
      return `[${t}] ${e.speaker} (${e.lang.toUpperCase()}): ${e.text}`;
    });
    const content = "LiveTranslate Call — Átirat\n" +
      "Dátum: " + new Date().toLocaleString() + "\n" +
      "=".repeat(50) + "\n\n" + lines.join("\n");
    this._download(content, "atiratok.txt", "text/plain");
  }

  async exportPDF() {
    if (this._entries.length === 0) { alert("Nincs átirat."); return; }
    await this._loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });

    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("LiveTranslate Call — Átirat", 15, 20);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(120, 120, 120);
    doc.text("Dátum: " + new Date().toLocaleString(), 15, 28);
    doc.text("Bejegyzések: " + this._entries.length, 15, 34);
    doc.setDrawColor(79, 209, 197);
    doc.line(15, 38, 195, 38);

    let y = 46;
    doc.setTextColor(0, 0, 0);

    this._entries.forEach(e => {
      if (y > 270) { doc.addPage(); y = 20; }
      const t = new Date(e.time).toLocaleTimeString([], {
        hour:"2-digit", minute:"2-digit", second:"2-digit"
      });
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      doc.text(`[${t}] ${e.speaker} — ${e.lang.toUpperCase()}`, 15, y);
      y += 5;
      doc.setFontSize(11);
      doc.setTextColor(e.isOwn ? 0 : 60, e.isOwn ? 100 : 60, e.isOwn ? 80 : 120);
      const lines = doc.splitTextToSize(e.text, 175);
      doc.text(lines, 15, y);
      y += lines.length * 6 + 4;
    });

    doc.save("LiveTranslate-atiratok.pdf");
  }

  async exportWord() {
    if (this._entries.length === 0) { alert("Nincs átirat."); return; }
    await this._loadScript("https://cdn.jsdelivr.net/npm/docx@8.2.3/build/index.js");
    const { Document, Paragraph, TextRun, HeadingLevel, Packer } = window.docx;

    const children = [
      new Paragraph({ text: "LiveTranslate Call — Átirat", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({
        children: [new TextRun({
          text: "Dátum: " + new Date().toLocaleString(),
          color: "888888", size: 18,
        })],
      }),
      new Paragraph({ text: "" }),
    ];

    this._entries.forEach(e => {
      const t = new Date(e.time).toLocaleTimeString([], {
        hour:"2-digit", minute:"2-digit", second:"2-digit"
      });
      children.push(new Paragraph({
        children: [
          new TextRun({
            text: `[${t}] ${e.speaker} (${e.lang.toUpperCase()}): `,
            bold: true, size: 18,
            color: e.isOwn ? "0a6640" : "1a3a7a",
          }),
          new TextRun({ text: e.text, size: 20 }),
        ],
      }));
    });

    const doc  = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "LiveTranslate-atiratok.docx";
    a.click();
    URL.revokeObjectURL(url);
  }

  _download(content, filename, mime) {
    const blob = new Blob([content], { type: mime + ";charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s   = document.createElement("script");
      s.src     = src;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  getEntries() { return [...this._entries]; }
  getCount()   { return this._entries.length; }
}


// ═══════════════════════════════════════════════════════════════
// 5. WEBHOOK RENDSZER
// ═══════════════════════════════════════════════════════════════

class WebhookManager {
  constructor(supabaseClient) {
    this._sb       = supabaseClient;
    this._roomId   = null;
    this._webhooks = [];
  }

  setRoomId(roomId) { this._roomId = roomId; }

  async loadWebhooks() {
    if (!this._sb) return;
    try {
      const { data, error } = await this._sb
        .from("webhooks")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      this._webhooks = data || [];
      console.log("[Webhook] Betöltve:", this._webhooks.length);
    } catch (e) {
      console.warn("[Webhook] Betöltési hiba:", e.message);
    }
  }

  async fire(event, payload) {
    const body = {
      event,
      room_id:   this._roomId,
      timestamp: new Date().toISOString(),
      payload,
    };

    if (this._sb) {
      try {
        await this._sb.from("webhook_logs").insert({
          room_id:  this._roomId,
          event:    event,
          payload:  body,
          fired_at: new Date().toISOString(),
        });
      } catch (_) {}
    }

    for (const wh of this._webhooks) {
      if (!wh.url || !wh.active) continue;
      if (wh.events && !wh.events.includes(event)) continue;
      try {
        await fetch(wh.url, {
          method:  "POST",
          headers: {
            "Content-Type":           "application/json",
            "X-LiveTranslate-Event":  event,
            "X-LiveTranslate-Secret": wh.secret || "",
          },
          body:   JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        console.log("[Webhook] ✅ Kiküldve:", event, "→", wh.url);
      } catch (e) {
        console.warn("[Webhook] Küldési hiba:", e.message);
      }
    }
  }

  async fireCallStarted(roomId, participants)  { await this.fire("call.started",       { roomId, participants }); }
  async fireCallEnded(roomId, duration, stats) { await this.fire("call.ended",         { roomId, duration, stats }); }
  async fireParticipantJoined(name, lang)      { await this.fire("participant.joined",  { name, lang }); }
  async fireParticipantLeft(name, duration)    { await this.fire("participant.left",    { name, duration }); }
  async fireTranscriptReady(entries)           { await this.fire("transcript.ready",   { count: entries.length }); }
}


// ═══════════════════════════════════════════════════════════════
// 6. WIDGET / BEÁGYAZHATÓSÁG — Web Components
// ═══════════════════════════════════════════════════════════════

class EmbedWidget {
  constructor() { this._defined = false; }

  define() {
    if (this._defined || customElements.get("livecall-widget")) return;
    this._defined = true;

    customElements.define("livecall-widget", class extends HTMLElement {
      constructor() {
        super();
        this._shadow = this.attachShadow({ mode: "open" });
      }

      connectedCallback() {
        const primaryColor = this.getAttribute("color")    || "#4fd1c5";
        const logo         = this.getAttribute("logo")     || "";
        const lang         = this.getAttribute("lang")     || "hu";
        const buttonText   = this.getAttribute("btn-text") || "Hívás indítása";
        const baseUrl      = this.getAttribute("base-url") || window.location.origin;

        this._shadow.innerHTML = `
          <style>
            :host { display:inline-block; font-family:'Manrope',system-ui,sans-serif; }
            .widget-btn {
              background:${primaryColor}; color:#08221f; border:none;
              border-radius:12px; padding:12px 24px; font-size:15px;
              font-weight:700; cursor:pointer;
              box-shadow:0 4px 18px rgba(79,209,197,.4);
              transition:transform .1s,box-shadow .2s;
              display:flex; align-items:center; gap:8px;
            }
            .widget-btn:hover { box-shadow:0 6px 24px rgba(79,209,197,.6); }
            .widget-btn:active { transform:scale(.97); }
            .widget-frame {
              position:fixed; inset:0; z-index:99999;
              background:rgba(0,0,0,.85);
              display:flex; align-items:center; justify-content:center;
            }
            .widget-iframe {
              width:100%; max-width:900px; height:90vh;
              border:none; border-radius:20px;
              box-shadow:0 20px 60px rgba(0,0,0,.7);
            }
            .widget-close {
              position:absolute; top:20px; right:20px;
              background:rgba(255,255,255,.15); border:none;
              color:#fff; font-size:24px; width:44px; height:44px;
              border-radius:50%; cursor:pointer;
              display:flex; align-items:center; justify-content:center;
            }
          </style>
          ${logo ? `<img src="${logo}" style="height:24px;object-fit:contain;">` : ""}
          <button class="widget-btn" id="startBtn">📞 ${buttonText}</button>
        `;

        this._shadow.getElementById("startBtn").onclick = () => {
          const overlay = document.createElement("div");
          overlay.className = "widget-frame";
          overlay.innerHTML = `
            <button class="widget-close" id="closeBtn">✕</button>
            <iframe class="widget-iframe"
              src="${baseUrl}/index.html?lang=${lang}&embedded=true"
              allow="camera;microphone;autoplay;clipboard-write;display-capture">
            </iframe>
          `;
          this._shadow.appendChild(overlay);
          overlay.querySelector("#closeBtn").onclick = () => overlay.remove();
        };
      }
    });

    console.log("[EmbedWidget] ✅ livecall-widget regisztrálva.");
  }

  generateEmbedCode(options = {}) {
    const {
      color   = "#4fd1c5",
      lang    = "hu",
      logo    = "",
      btnText = "Hívás indítása",
      baseUrl = window.location.origin,
    } = options;
    return `<script src="${baseUrl}/livecall-sdk.js"><\/script>\n` +
      `<livecall-widget color="${color}" lang="${lang}" logo="${logo}" btn-text="${btnText}" base-url="${baseUrl}"><\/livecall-widget>`;
  }
}


// ═══════════════════════════════════════════════════════════════
// 7. REST API KLIENS
// ═══════════════════════════════════════════════════════════════

class ApiClient {
  constructor(supabaseClient, baseUrl) {
    this._sb      = supabaseClient;
    this._baseUrl = baseUrl || window.location.origin;
  }

  async createRoom(options = {}) {
    const roomId = options.roomId || this._randomCode();
    if (this._sb) {
      try {
        await this._sb.from("calls").upsert({
          room_id:           roomId,
          started_at:        new Date().toISOString(),
          participant_count: 0,
          last_seen:         new Date().toISOString(),
        }, { onConflict: "room_id" });
      } catch (e) {
        console.warn("[ApiClient] Szoba mentési hiba:", e.message);
      }
    }
    return {
      roomId,
      joinUrl:   `${this._baseUrl}/index.html?room=${roomId}`,
      embedUrl:  `${this._baseUrl}/index.html?room=${roomId}&embedded=true`,
      createdAt: new Date().toISOString(),
    };
  }

  async generateToken(roomId, userName) {
  const base = (window.LIVECALL_CONFIG && window.LIVECALL_CONFIG.supabaseUrl) || "https://yyexlblyepkxyqqbgpvu.supabase.co";
  try {
    const res = await fetch(`${base}/functions/v1/livekit-token`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ roomId, userName }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const { token } = await res.json();
    return { token, roomId, userName };
  } catch (e) {
    console.error("[ApiClient] Token hiba:", e.message);
    throw e;
  }
}

  async translate(text, src, tgt, groqKey) {
  const base = (window.LIVECALL_CONFIG && window.LIVECALL_CONFIG.supabaseUrl) || "https://yyexlblyepkxyqqbgpvu.supabase.co";
  try {
    const res = await fetch(`${base}/functions/v1/groq-translate`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "x-groq-key":   groqKey || "",
      },
      body:   JSON.stringify({ text, src, tgt }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.error("[ApiClient] Fordítás hiba:", e.message);
    throw e;
  }
}

  async listRooms(limit = 20) {
    if (!this._sb) return [];
    try {
      const { data, error } = await this._sb
        .from("calls")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.warn("[ApiClient] Listázás hiba:", e.message);
      return [];
    }
  }

  _randomCode() {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join("");
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s   = document.createElement("script");
      s.src     = src;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
}


// ═══════════════════════════════════════════════════════════════
// 8. ANALITIKA — MOS SCORE
// ═══════════════════════════════════════════════════════════════

class Analytics {
  constructor(supabaseClient) {
    this._sb         = supabaseClient;
    this._roomId     = null;
    this._peerId     = null;
    this._interval   = null;
    this._getPcFn    = null;
    this._mosHistory = [];
    this._onUpdate   = null;
  }

  init(roomId, peerId, getPeerConnectionFn, onUpdate) {
    this._roomId   = roomId;
    this._peerId   = peerId;
    this._getPcFn  = getPeerConnectionFn;
    this._onUpdate = onUpdate || (() => {});
  }

  start() {
    this._interval = setInterval(() => this._collect(), 3000);
    console.log("[Analytics] Mérés elindítva.");
  }

async _collect() {
    const pc = this._getPcFn?.();
    if (!pc || typeof pc.getStats !== "function") return;
    try {
      const stats = await pc.getStats();
      let rtt = null, jitter = null, loss = null, bwKb = null;
      let packetsLost = 0, packetsReceived = 0;
      let prevBytes = this._prevBytes || 0;
      let prevTs    = this._prevTs    || 0;

      stats.forEach(r => {
        if (
          r.type === "candidate-pair" &&
          r.state === "succeeded" &&
          r.currentRoundTripTime != null
        ) {
          rtt = Math.round(r.currentRoundTripTime * 1000);
        }
        if (r.type === "inbound-rtp" && r.kind === "audio") {
          jitter       = r.jitter != null ? Math.round(r.jitter * 1000) : null;
          packetsLost     = r.packetsLost     || 0;
          packetsReceived = r.packetsReceived || 0;
          if (packetsLost + packetsReceived > 0) {
            loss = ((packetsLost / (packetsLost + packetsReceived)) * 100).toFixed(2);
          }
        }
        if (r.type === "inbound-rtp" && r.kind === "video" && r.bytesReceived != null) {
          const now = Date.now();
          if (prevTs && prevBytes) {
            const dt = (now - prevTs) / 1000;
            if (dt > 0) bwKb = Math.round((r.bytesReceived - prevBytes) / 1024 / dt);
          }
          this._prevBytes = r.bytesReceived;
          this._prevTs    = Date.now();
        }
      });

      const mos    = this._calculateMOS(rtt, jitter, parseFloat(loss));
      this._mosHistory.push(mos);
      if (this._mosHistory.length > 60) this._mosHistory.shift();
      const avgMos = this._mosHistory.reduce((a, b) => a + b, 0) / this._mosHistory.length;

      const result = {
        rtt,
        jitter,
        loss:    loss ? loss + "%" : null,
        bwKb,
        mos:     mos.toFixed(2),
        avgMos:  avgMos.toFixed(2),
        quality: this._mosToQuality(mos),
      };

      this._onUpdate(result);
      await this._saveToSupabase(result);
    } catch (e) {
      console.warn("[Analytics] _collect hiba:", e.message);
    }
  }


  _calculateMOS(rtt, jitter, lossPercent) {
    if (rtt === null) return 3.5;
    const effectiveLatency = (rtt || 0) + (jitter || 0) * 2 + 10;
    let r;
    if (effectiveLatency < 160) {
      r = 93.2 - effectiveLatency / 40;
    } else {
      r = 93.2 - effectiveLatency / 120 - 10;
    }
    r = r - (lossPercent || 0) * 2.5;
    r = Math.max(0, Math.min(100, r));
    if (r < 0)   return 1;
    if (r > 100) return 4.5;
    return 1 + 0.035 * r + 7 * 0.000001 * r * (r - 60) * (100 - r);
  }

  _mosToQuality(mos) {
    if (mos >= 4.0) return "Kiváló";
    if (mos >= 3.5) return "Jó";
    if (mos >= 3.0) return "Elfogadható";
    if (mos >= 2.0) return "Gyenge";
    return "Nagyon gyenge";
  }

  async _saveToSupabase(stats) {
    if (!this._sb || !this._roomId) return;
    try {
      await this._sb.from("call_quality_logs").insert({
        room_id:   this._roomId,
        peer_id:   this._peerId,
        rtt:       stats.rtt,
        jitter:    stats.jitter,
        loss:      parseFloat(stats.loss) || 0,
        mos:       parseFloat(stats.mos),
        bw_kb:     stats.bwKb,
        logged_at: new Date().toISOString(),
      });
    } catch (_) {}
  }

  getMosHistory() { return [...this._mosHistory]; }

  stop() {
    clearInterval(this._interval);
    this._interval = null;
    console.log("[Analytics] Leállítva.");
  }
}


// ═══════════════════════════════════════════════════════════════
// 9. FORDÍTÁS VISSZAJELZÉS
// ═══════════════════════════════════════════════════════════════

class TranslationFeedback {
  constructor(supabaseClient) {
    this._sb = supabaseClient;
  }

  attachToCaption(captionEl, original, translated, srcLang, tgtLang) {
    const existing = captionEl.querySelector(".feedback-btns");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.className = "feedback-btns";
    wrap.style.cssText = "display:flex;gap:6px;justify-content:center;margin-top:6px;";

    const upBtn   = document.createElement("button");
    upBtn.textContent = "👍";
    upBtn.style.cssText = this._btnStyle("#48bb78");

    const downBtn = document.createElement("button");
    downBtn.textContent = "👎";
    downBtn.style.cssText = this._btnStyle("#e2586b");

    upBtn.onclick = async () => {
      await this._save(original, translated, srcLang, tgtLang, true);
      upBtn.textContent  = "✅";
      upBtn.disabled     = true;
      downBtn.disabled   = true;
    };

    downBtn.onclick = async () => {
      await this._save(original, translated, srcLang, tgtLang, false);
      downBtn.textContent = "❌";
      upBtn.disabled      = true;
      downBtn.disabled    = true;
    };

    wrap.appendChild(upBtn);
    wrap.appendChild(downBtn);
    captionEl.appendChild(wrap);
  }

  async _save(original, translated, srcLang, tgtLang, positive) {
    if (!this._sb) return;
    try {
      await this._sb.from("translation_feedback").insert({
        original:   original,
        translated: translated,
        src_lang:   srcLang,
        tgt_lang:   tgtLang,
        positive:   positive,
        created_at: new Date().toISOString(),
      });
      console.log("[Feedback] ✅ Mentve:", positive ? "👍" : "👎");
    } catch (e) {
      console.warn("[Feedback] Mentési hiba:", e.message);
    }
  }

  _btnStyle(color) {
    return `background:${color}22;border:1px solid ${color}55;color:${color};` +
      `font-size:16px;padding:3px 10px;border-radius:8px;cursor:pointer;transition:background .15s;`;
  }

  async getStats() {
    if (!this._sb) return null;
    try {
      const { data, error } = await this._sb
        .from("translation_feedback")
        .select("positive");
      if (error) throw error;
      const total    = data.length;
      const positive = data.filter(r => r.positive).length;
      return {
        total,
        positive,
        negative: total - positive,
        accuracy: total > 0 ? ((positive / total) * 100).toFixed(1) + "%" : "–",
      };
    } catch (e) {
      console.warn("[Feedback] Stats hiba:", e.message);
      return null;
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// 10. GDPR / ADATTÖRLÉS
// ═══════════════════════════════════════════════════════════════

class GdprManager {
  constructor(supabaseClient) {
    this._sb = supabaseClient;
  }

  async deleteRoomData(roomId) {
    if (!this._sb || !roomId) return { success: false };
    const tables = [
      "calls", "call_participants", "chat_history",
      "webhook_logs", "call_quality_logs", "translation_feedback",
    ];
    const results = [];
    for (const table of tables) {
      try {
        const { error } = await this._sb.from(table).delete().eq("room_id", roomId);
        results.push({ table, ok: !error });
        if (!error) console.log(`[GDPR] ✅ ${table} törölve`);
      } catch (e) {
        results.push({ table, ok: false });
      }
    }
    return { success: results.every(r => r.ok), results };
  }

  async deleteOlderThan(days = 5) {
    if (!this._sb) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const iso = cutoff.toISOString();

    const tables = [
      { name: "calls",                col: "started_at" },
      { name: "call_participants",    col: "joined_at" },
      { name: "chat_history",         col: "created_at" },
      { name: "webhook_logs",         col: "fired_at" },
      { name: "call_quality_logs",    col: "logged_at" },
      { name: "translation_feedback", col: "created_at" },
      { name: "debug_logs",           col: "created_at" },
    ];

    for (const { name, col } of tables) {
      try {
        const { error } = await this._sb.from(name).delete().lt(col, iso);
        if (!error) console.log(`[GDPR] ✅ ${name}: régi adatok törölve`);
      } catch (e) {
        console.warn(`[GDPR] ${name} hiba:`, e.message);
      }
    }
  }

  async exportRoomData(roomId) {
    if (!this._sb || !roomId) return null;
    const tables = ["calls", "call_participants", "chat_history"];
    const result = {};
    for (const t of tables) {
      try {
        const { data } = await this._sb.from(t).select("*").eq("room_id", roomId);
        result[t] = data || [];
      } catch (_) { result[t] = []; }
    }
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `gdpr-export-${roomId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return result;
  }

  getComplianceStatus() {
    return {
      dataLocation:    "EU (Supabase EU West)",
      encryption:      "TLS 1.3 + E2EE chat",
      retentionPolicy: "30 nap",
      rightToErasure:  "Implementálva",
      dataPortability: "JSON export",
      gdprCompliant:   true,
    };
  }
}


// ═══════════════════════════════════════════════════════════════
// GLOBÁLIS ELÉRHETŐSÉG — window objektumra rakjuk
// ═══════════════════════════════════════════════════════════════

window.RoomManager          = RoomManager;
window.NetworkAdaptation    = NetworkAdaptation;
window.NoiseCancellation    = NoiseCancellation;
window.TranscriptExporter   = TranscriptExporter;
window.WebhookManager       = WebhookManager;
window.EmbedWidget          = EmbedWidget;
window.ApiClient            = ApiClient;
window.Analytics            = Analytics;
window.TranslationFeedback  = TranslationFeedback;
window.GdprManager          = GdprManager;

console.log("✅ livecall-sdk.js betöltve — minden osztály elérhető.");
