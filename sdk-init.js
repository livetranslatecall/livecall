// sdk-init.js
(function () {

  let _transcriptExporter  = null;
  let _noiseCancellation   = null;
  let _analytics           = null;
  let _translationFeedback = null;
  let _networkAdaptation   = null;
  
  let _gdprManager         = null;
  let _embedWidget         = null;

  function _getCtx() {
    return {
      sb:      window.supabaseClient,
      roomId:  window.roomId,
      peerId:  window.myPeerId,
      name:    window.myName,
      lang:    window.myLang,
      peers:   window.peers,
      lk:      window.livekitRoom,
    };
  }

  async function _initSDK() {
    const ctx = _getCtx();
    console.log("[sdk-init] 🚀 _initSDK indul", ctx);

    if (!ctx.sb) { console.warn("[sdk-init] ❌ supabaseClient hiányzik"); return; }

    // 1. TranscriptExporter
    try {
      _transcriptExporter = new window.TranscriptExporter();
      console.log("[sdk-init] ✅ TranscriptExporter kész");
    } catch(e) { console.error("[sdk-init] ❌ TranscriptExporter:", e.message); }

    // 2. NoiseCancellation
    try {
      _noiseCancellation = new window.NoiseCancellation();
      console.log("[sdk-init] ✅ NoiseCancellation kész");
    } catch(e) { console.error("[sdk-init] ❌ NoiseCancellation:", e.message); }

    // 3. Analytics
    try {
      _analytics = new window.Analytics(ctx.sb);
      _analytics.init(
        ctx.roomId,
        ctx.peerId,
        () => { const f = window.peers?.values().next().value; return f?.pc || null; },
        (result) => {
          const mosEl = document.getElementById("statMos");
          if (mosEl) {
            mosEl.textContent = result.mos + " (" + result.quality + ")";
            mosEl.style.color =
              result.quality === "Kiváló" || result.quality === "Jó" ? "var(--green)"
              : result.quality === "Elfogadható" ? "var(--amber)"
              : "var(--danger)";
          }
        }
      );
      _analytics.start();
      console.log("[sdk-init] ✅ Analytics kész");
    } catch(e) { console.error("[sdk-init] ❌ Analytics:", e.message); }

    // 4. TranslationFeedback
    try {
      _translationFeedback = new window.TranslationFeedback(ctx.sb);
      console.log("[sdk-init] ✅ TranslationFeedback kész");
    } catch(e) { console.error("[sdk-init] ❌ TranslationFeedback:", e.message); }

    
    // 6. GdprManager
    try {
      _gdprManager = new window.GdprManager(ctx.sb);
      console.log("[sdk-init] ✅ GdprManager kész");
    } catch(e) { console.error("[sdk-init] ❌ GdprManager:", e.message); }

    // 7. NetworkAdaptation
    try {
      _networkAdaptation = new window.NetworkAdaptation(() => window.livekitRoom);
      _networkAdaptation.start((quality) => {
        if (quality === "good")      window.setNetStatus?.("good");
        else if (quality === "warn") window.setNetStatus?.("warn");
        else                         window.setNetStatus?.("bad");
      });
      console.log("[sdk-init] ✅ NetworkAdaptation kész");
    } catch(e) { console.error("[sdk-init] ❌ NetworkAdaptation:", e.message); }

    // 8. EmbedWidget
    try {
      if (!_embedWidget) {
        _embedWidget = new window.EmbedWidget();
        _embedWidget.define();
        console.log("[sdk-init] ✅ EmbedWidget kész");
      }
    } catch(e) { console.error("[sdk-init] ❌ EmbedWidget:", e.message); }

    // 9. NoiseCancellation bekötése
    await _initNoiseCancellation();

    // 10. UI kiegészítések
    _showExportUI();
    _addMosStatRow();

    // 11. Caption observer
    _patchCaptionHandling();

    console.log("[sdk-init] ✅ Minden modul inicializálva. roomId:", ctx.roomId, "peerId:", ctx.peerId);
  }

  async function _initNoiseCancellation() {
    const stream = window.localStream;
    if (!stream || !_noiseCancellation) {
      console.log("[sdk-init] ⏭️ NoiseCancellation skip (nincs stream vagy modul)");
      return;
    }
    try {
      const filtered = await _noiseCancellation.init(stream);
      if (window.peers) {
        window.peers.forEach((p) => {
          const senders = p.pc?.getSenders() || [];
          filtered.getTracks().forEach(track => {
            const sender = senders.find(s => s.track?.kind === track.kind && track.kind === "audio");
            if (sender) sender.replaceTrack(track).catch(() => {});
          });
        });
      }
      console.log("[sdk-init] ✅ NoiseCancellation bekötve");
    } catch(e) {
      console.warn("[sdk-init] ⚠️ NoiseCancellation hiba:", e.message);
    }
  }

  function _addMosStatRow() {
    const statsOverlay = document.getElementById("statsOverlay");
    if (!statsOverlay || document.getElementById("statMos")) return;
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `<span>MOS</span><span class="stat-val" id="statMos" style="color:var(--green)">--</span>`;
    statsOverlay.appendChild(row);
    console.log("[sdk-init] ✅ MOS sor hozzáadva");
  }

  function _showExportUI() {
    if (document.getElementById("exportBtn")) {
      console.log("[sdk-init] ⏭️ exportBtn már létezik, skip");
      return;
    }
    const controls = document.querySelector(".controls");
    if (!controls) {
      console.warn("[sdk-init] ❌ .controls nem található");
      return;
    }

    const btn = document.createElement("button");
    btn.className = "ctrl-btn";
    btn.id = "exportBtn";
    btn.innerHTML = `<span class="btn-icon">📤</span><span class="btn-label">Export</span>`;
    controls.appendChild(btn);
    console.log("[sdk-init] ✅ exportBtn hozzáadva a controls-hoz");

    const menu = document.createElement("div");
    menu.id = "exportMenu";
    menu.style.cssText = [
      "position:absolute", "bottom:84px", "left:50%", "transform:translateX(-50%)",
      "background:var(--panel)", "border:1px solid var(--line)", "border-radius:14px",
      "padding:8px", "display:none", "z-index:11",
      "box-shadow:0 10px 30px rgba(0,0,0,.5)", "min-width:180px",
    ].join(";");

    const options = [
      { label: "📄 TXT export",   fn: () => _transcriptExporter?.exportTXT() },
      { label: "🎬 SRT export",   fn: () => _transcriptExporter?.exportSRT() },
      { label: "📕 PDF export",   fn: () => _transcriptExporter?.exportPDF() },
      { label: "📝 Word export",  fn: () => _transcriptExporter?.exportWord() },
      { label: "🗑️ GDPR törlés", fn: () => _gdprManager?.deleteRoomData(window.roomId) },
    ];

    options.forEach(opt => {
      const b = document.createElement("button");
      b.style.cssText = "display:block;width:100%;text-align:left;padding:10px 14px;" +
        "background:none;border:none;color:var(--text);font-size:14px;border-radius:8px;cursor:pointer;";
      b.textContent = opt.label;
      b.onmouseenter = () => b.style.background = "var(--panel-2)";
      b.onmouseleave = () => b.style.background = "none";
      b.onclick = () => { opt.fn(); menu.style.display = "none"; };
      menu.appendChild(b);
    });

    document.getElementById("call").appendChild(menu);

    btn.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "block" : "none";
      console.log("[sdk-init] 📤 Export menü:", menu.style.display);
    };

    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.style.display = "none";
      }
    });
  }

  function _patchCaptionHandling() {
    const incomingMain = document.getElementById("incomingMain");
    const ownMain      = document.getElementById("ownMain");
    const incomingBox  = document.getElementById("incomingCaptionBox");

    if (!incomingMain || !ownMain) {
      console.warn("[sdk-init] ❌ Caption elemek nem találhatók");
      return;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach(m => {
        if (m.target === incomingMain && incomingMain.textContent.trim()) {
          const text = incomingMain.textContent.trim();
          const tag  = document.getElementById("incomingTag")?.textContent || "Partner";
          _transcriptExporter?.addEntry(text, tag, window.myLang, false);
          if (incomingBox && _translationFeedback) {
            const orig = document.getElementById("incomingSub")?.textContent || text;
            _translationFeedback.attachToCaption(incomingBox, orig, text, "auto", window.myLang);
          }
        }
        if (m.target === ownMain && ownMain.textContent.trim()) {
          _transcriptExporter?.addEntry(
            ownMain.textContent.trim(),
            window.myName || "Te",
            window.myLang,
            true
          );
        }
      });
    });

    observer.observe(incomingMain, { childList: true, characterData: true, subtree: true });
    observer.observe(ownMain,      { childList: true, characterData: true, subtree: true });
    console.log("[sdk-init] ✅ Caption observer aktív");
  }

  function _cleanupSDK() {
    console.log("[sdk-init] 🧹 Cleanup indul...");



    try { _analytics?.stop(); } catch(_) {}
    try { _networkAdaptation?.stop(); } catch(_) {}
    try { _noiseCancellation?.destroy(); } catch(_) {}

    document.getElementById("exportBtn")?.remove();
    document.getElementById("exportMenu")?.remove();
    document.getElementById("statMos")?.closest(".stat-row")?.remove();

    _transcriptExporter  = null;
    _noiseCancellation   = null;
    _analytics           = null;
    _translationFeedback = null;
    _networkAdaptation   = null;
    _webhookManager      = null;
    _gdprManager         = null;

    console.log("[sdk-init] ✅ Cleanup kész");
  }

  function _watchCallState() {
    let callActive = false;
    console.log("[sdk-init] 👁️ _watchCallState polling indul");

    setInterval(() => {
      const isActive = document.getElementById("call")?.classList.contains("active") ?? false;

      if (isActive && !callActive) {
        callActive = true;
        console.log("[sdk-init] 📞 Hívás észlelve, SDK init 1500ms múlva...");
        console.log("[sdk-init] 🔍 Jelenlegi window változók:",
          "supabaseClient:", !!window.supabaseClient,
          "roomId:", window.roomId,
          "myPeerId:", window.myPeerId,
          "myName:", window.myName,
          "peers:", !!window.peers
        );
        setTimeout(() => {
          console.log("[sdk-init] ⏰ Timeout lejárt, window változók most:",
            "supabaseClient:", !!window.supabaseClient,
            "roomId:", window.roomId,
            "myPeerId:", window.myPeerId
          );
          if (window.supabaseClient) {
            _initSDK();
          } else {
            console.error("[sdk-init] ❌ supabaseClient még mindig hiányzik, SDK nem indul el!");
          }
        }, 1500);
      }

      if (!isActive && callActive) {
        callActive = false;
        _cleanupSDK();
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _watchCallState);
  } else {
    _watchCallState();
  }

})();
