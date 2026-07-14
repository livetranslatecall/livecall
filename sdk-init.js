// sdk-init.js
// Az index.html változóihoz kapcsolódik — semmit nem ír felül
// Betöltési sorrend: index.html betölti a livecall-sdk.js-t, majd ezt

// ═══════════════════════════════════════════════════════════════
// VÁRAKOZÁS AMÍG AZ INDEX.HTML TELJESEN BETÖLT
// ═══════════════════════════════════════════════════════════════

(function () {

  // ── SDK példányok ──
  let _transcriptExporter  = null;
  let _noiseCancellation   = null;
  let _analytics           = null;
  let _translationFeedback = null;
  let _roomManager         = null;
  let _networkAdaptation   = null;
  let _webhookManager      = null;
  let _gdprManager         = null;
  let _embedWidget         = null;

  // ── Eredeti függvények mentése (monkey-patch előtt) ──
  let _originalBeginCallFlow      = null;
  let _originalDoHangup           = null;
  let _originalHandleIncoming     = null;
  let _originalAddHistoryItem     = null;

  // ═══════════════════════════════════════════════════════════════
  // INIT — hívás kezdetén fut le
  // ═══════════════════════════════════════════════════════════════

  function _initSDK() {
    const sb = window.supabaseClient;

    // 1. TranscriptExporter
    _transcriptExporter = new window.TranscriptExporter();

    // 2. NoiseCancellation
    _noiseCancellation = new window.NoiseCancellation();

    // 3. Analytics
    _analytics = new window.Analytics(sb);
    _analytics.init(
      window.roomId,
      window.myPeerId,
      () => {
        // Az első peer PC-jét adjuk át
        const first = window.peers?.values().next().value;
        return first?.pc || null;
      },
      (result) => {
        // MOS score megjelenítése a stats panelben
        const mosEl = document.getElementById("statMos");
        if (mosEl) {
          mosEl.textContent = result.mos + " (" + result.quality + ")";
          mosEl.style.color = result.quality === "Kiváló" || result.quality === "Jó"
            ? "var(--green)"
            : result.quality === "Elfogadható"
            ? "var(--amber)"
            : "var(--danger)";
        }
      }
    );

    // 4. TranslationFeedback
    _translationFeedback = new window.TranslationFeedback(sb);

    // 5. WebhookManager
    _webhookManager = new window.WebhookManager(sb);
    _webhookManager.setRoomId(window.roomId);
    _webhookManager.loadWebhooks();
    _webhookManager.fireCallStarted(window.roomId, [window.myName]);

    // 6. GdprManager
    _gdprManager = new window.GdprManager(sb);

    // 7. NetworkAdaptation
    _networkAdaptation = new window.NetworkAdaptation(() => window.livekitRoom);
    _networkAdaptation.start((quality, rtt) => {
      if (quality === "good") window.setNetStatus?.("good");
      else if (quality === "warn") window.setNetStatus?.("warn");
      else window.setNetStatus?.("bad");
    });

    // 8. EmbedWidget regisztrálása
    if (!_embedWidget) {
      _embedWidget = new window.EmbedWidget();
      _embedWidget.define();
    }

    // 9. NoiseCancellation bekötése ha van localStream
    _initNoiseCancellation();

    // 10. Analytics indítása
    _analytics.start();

    // 11. Export UI megjelenítése
    _showExportUI();

    // 12. MOS sor hozzáadása a stats panelhez
    _addMosStatRow();

    console.log("[sdk-init] ✅ Minden SDK modul inicializálva.");
  }

  // ═══════════════════════════════════════════════════════════════
  // NOISE CANCELLATION BEKÖTÉSE
  // ═══════════════════════════════════════════════════════════════

  async function _initNoiseCancellation() {
    const stream = window.localStream;
    if (!stream || !_noiseCancellation) return;
    try {
      const filtered = await _noiseCancellation.init(stream);
      // A szűrt stream csak a WebRTC peereken megy át
      // A localStream-et NEM cseréljük le (hogy a STT érintetlen maradjon)
      if (window.peers) {
        window.peers.forEach((p) => {
          const senders = p.pc?.getSenders() || [];
          filtered.getTracks().forEach(track => {
            const sender = senders.find(s => s.track?.kind === track.kind && track.kind === "audio");
            if (sender) sender.replaceTrack(track).catch(() => {});
          });
        });
      }
      console.log("[sdk-init] ✅ NoiseCancellation bekötve.");
    } catch (e) {
      console.warn("[sdk-init] NoiseCancellation hiba:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MOS SOR HOZZÁADÁSA A STATS PANELHEZ
  // ═══════════════════════════════════════════════════════════════

  function _addMosStatRow() {
    const statsOverlay = document.getElementById("statsOverlay");
    if (!statsOverlay || document.getElementById("statMos")) return;
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `<span>MOS</span><span class="stat-val" id="statMos" style="color:var(--green)">--</span>`;
    statsOverlay.appendChild(row);
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPORT UI — gomb a controls sorba
  // ═══════════════════════════════════════════════════════════════

  function _showExportUI() {
    if (document.getElementById("exportBtn")) return;

    const controls = document.querySelector(".controls");
    if (!controls) return;

    const btn = document.createElement("button");
    btn.className = "ctrl-btn";
    btn.id = "exportBtn";
    btn.innerHTML = `<span class="btn-icon">📤</span><span class="btn-label">Export</span>`;
    controls.appendChild(btn);

    // Export menü
    const menu = document.createElement("div");
    menu.id = "exportMenu";
    menu.style.cssText = `
      position:absolute;bottom:84px;left:50%;transform:translateX(-50%);
      background:var(--panel);border:1px solid var(--line);border-radius:14px;
      padding:8px;display:none;z-index:11;box-shadow:0 10px 30px rgba(0,0,0,.5);
      min-width:180px;
    `;

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
    };

    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.style.display = "none";
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // FELIRATOK KIBŐVÍTÉSE — TranscriptExporter + TranslationFeedback
  // ═══════════════════════════════════════════════════════════════

  function _patchCaptionHandling() {
    // A handleIncomingCaption után hívjuk az addEntry-t
    // Polling alapon figyeljük az incomingMain szövegét
    const incomingMain = document.getElementById("incomingMain");
    const ownMain      = document.getElementById("ownMain");
    const incomingBox  = document.getElementById("incomingCaptionBox");

    if (!incomingMain || !ownMain) return;

    // MutationObserver — figyeli ha változik a felirat szövege
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(m => {
        if (m.target === incomingMain && incomingMain.textContent.trim()) {
          const text = incomingMain.textContent.trim();
          const tag  = document.getElementById("incomingTag")?.textContent || "Partner";
          _transcriptExporter?.addEntry(text, tag, window.myLang, false);

          // TranslationFeedback csatolása
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

    console.log("[sdk-init] ✅ Caption observer aktív.");
  }

  // ═══════════════════════════════════════════════════════════════
  // HÍVÁS VÉGE — cleanup
  // ═══════════════════════════════════════════════════════════════

  function _cleanupSDK() {
    // Webhook
    _webhookManager?.fireCallEnded(window.roomId, 0, {});

    // TranscriptExporter webhook
    if (_transcriptExporter && _webhookManager) {
      _webhookManager.fireTranscriptReady(_transcriptExporter.getEntries());
    }

    // Analytics leállítása
    _analytics?.stop();

    // NetworkAdaptation leállítása
    _networkAdaptation?.stop();

    // NoiseCancellation leállítása
    _noiseCancellation?.destroy();

    // Export gomb eltávolítása
    document.getElementById("exportBtn")?.remove();
    document.getElementById("exportMenu")?.remove();
    document.getElementById("statMos")?.closest(".stat-row")?.remove();

    // Reset
    _transcriptExporter  = null;
    _noiseCancellation   = null;
    _analytics           = null;
    _translationFeedback = null;
    _networkAdaptation   = null;

    console.log("[sdk-init] ✅ SDK cleanup kész.");
  }

  // ═══════════════════════════════════════════════════════════════
  // MEGFIGYELŐ — várja hogy a hívás elinduljon és véget érjen
  // ═══════════════════════════════════════════════════════════════

  function _watchCallState() {
    let callActive = false;

    setInterval(() => {
      const callScreen = document.getElementById("call");
      const isActive   = callScreen?.classList.contains("active");

      if (isActive && !callActive) {
        // Hívás éppen elindult
        callActive = true;
        // Kis késleltetés hogy a supabaseClient és roomId biztosan be legyen állítva
        setTimeout(() => {
          if (window.supabaseClient && window.roomId) {
            _initSDK();
            _patchCaptionHandling();
          }
        }, 1500);
      }

      if (!isActive && callActive) {
        // Hívás véget ért
        callActive = false;
        _cleanupSDK();
      }
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════
  // INDÍTÁS
  // ═══════════════════════════════════════════════════════════════

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _watchCallState);
  } else {
    _watchCallState();
  }

})();