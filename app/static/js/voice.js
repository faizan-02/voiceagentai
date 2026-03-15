/**
 * voice.js — Frontend logic for the browser-based voice chat UI.
 *
 * Flow:
 *  1. Page load  → fetch /characters → populate dropdown.
 *  2. User clicks Start → request mic permission → open WebSocket → send "start".
 *  3. VAD (AudioContext + AnalyserNode) detects speech energy:
 *       energy > threshold for >300 ms  → start MediaRecorder
 *       energy < threshold for >1500 ms → stop MediaRecorder → encode → send "audio"
 *  4. Handle server messages: listening / thinking / transcript /
 *     response_text / audio_response / done / error.
 *  5. User clicks Stop → close everything → reset UI.
 */

(function () {
  "use strict";

  // ── DOM refs ───────────────────────────────────────────────────
  const orb             = document.getElementById("orb");
  const statusText      = document.getElementById("statusText");
  const transcriptPanel = document.getElementById("transcriptPanel");
  const transcriptEmpty = document.getElementById("transcriptEmpty");
  const btnStart        = document.getElementById("btnStart");
  const btnStop         = document.getElementById("btnStop");
  const settingsToggle  = document.getElementById("settingsToggle");
  const settingsPanel   = document.getElementById("settingsPanel");
  const errorToast      = document.getElementById("errorToast");
  const characterSelect = document.getElementById("characterSelect");
  const modelSelect     = document.getElementById("modelSelect");
  const voiceSelect     = document.getElementById("voiceSelect");

  // ── VAD config ────────────────────────────────────────────────
  const VAD_ENERGY_THRESHOLD = 0.012;  // 0–1 RMS normalised
  const VAD_SPEECH_MIN_MS    = 300;    // must be loud for this long to start recording
  const VAD_SILENCE_MIN_MS   = 1500;   // must be quiet for this long to stop

  // ── State ─────────────────────────────────────────────────────
  let ws              = null;
  let audioCtx        = null;
  let analyser        = null;
  let mediaStream     = null;
  let mediaRecorder   = null;
  let recordedChunks  = [];
  let vadActive       = false;   // true when VAD loop is running
  let isRecording     = false;   // true while MediaRecorder is running
  let isSpeaking      = false;   // waiting for server audio to finish
  let speechStartTime = null;    // when we first detected energy above threshold
  let silenceStartTime = null;   // when we first detected energy below threshold
  let vadRafId        = null;    // requestAnimationFrame handle

  // ── Settings toggle ───────────────────────────────────────────
  settingsToggle.addEventListener("click", () => {
    const open = settingsPanel.classList.toggle("open");
    settingsToggle.classList.toggle("open", open);
    settingsToggle.setAttribute("aria-expanded", String(open));
  });

  // ── Load characters ───────────────────────────────────────────
  async function loadCharacters() {
    try {
      const res  = await fetch("/characters");
      const data = await res.json();
      const list = data.characters || [];

      characterSelect.innerHTML = "";
      list.forEach((name) => {
        const opt  = document.createElement("option");
        opt.value  = name;
        opt.textContent = name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        characterSelect.appendChild(opt);
      });

      // Default to "wizard" if present
      const wizardOpt = [...characterSelect.options].find((o) => o.value === "wizard");
      if (wizardOpt) wizardOpt.selected = true;
    } catch (err) {
      console.error("Failed to load characters:", err);
      characterSelect.innerHTML = '<option value="wizard">Wizard</option>';
    }
  }

  loadCharacters();

  // ── UI helpers ────────────────────────────────────────────────
  function setOrbState(state) {
    orb.className = "orb " + state;
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function showError(msg) {
    errorToast.textContent = msg;
    errorToast.style.display = "block";
    setTimeout(() => { errorToast.style.display = "none"; }, 5000);
  }

  function appendMessage(role, text) {
    if (transcriptEmpty) transcriptEmpty.remove();

    const div     = document.createElement("div");
    div.className = "message " + (role === "user" ? "user" : "ai");

    const label   = document.createElement("div");
    label.className = "label";
    label.textContent = role === "user" ? "You" : "AI";

    const content = document.createElement("div");
    content.className = "content";
    content.textContent = text;

    div.appendChild(label);
    div.appendChild(content);
    transcriptPanel.appendChild(div);
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  }

  // ── WebSocket ─────────────────────────────────────────────────
  function openWebSocket() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url   = `${proto}://${location.host}/ws_voice`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("ws_voice: connected");
      ws.send(JSON.stringify({
        action:    "start",
        character: characterSelect.value,
        model:     modelSelect.value,
        voice:     voiceSelect.value,
      }));
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); }
      catch (e) { console.warn("ws_voice: invalid JSON", event.data); return; }

      handleServerMessage(msg);
    };

    ws.onclose = () => {
      console.log("ws_voice: closed");
      stopAll();
    };

    ws.onerror = (err) => {
      console.error("ws_voice: error", err);
      showError("WebSocket connection error.");
      stopAll();
    };
  }

  function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  // ── Server message handler ────────────────────────────────────
  function handleServerMessage(msg) {
    switch (msg.action) {

      case "listening":
        isSpeaking = false;
        setOrbState("listening");
        setStatus("Listening…");
        startVAD();
        break;

      case "thinking":
        stopVAD();
        setOrbState("thinking");
        setStatus("Thinking…");
        break;

      case "transcript":
        appendMessage("user", msg.text);
        break;

      case "response_text":
        appendMessage("ai", msg.text);
        break;

      case "audio_response":
        stopVAD();
        isSpeaking = true;
        setOrbState("speaking");
        setStatus("Speaking…");
        playAudioResponse(msg.data, msg.format || "wav");
        break;

      case "done":
        // VAD will restart once audio playback ends (or immediately if no audio)
        if (!isSpeaking) {
          setOrbState("listening");
          setStatus("Listening…");
          startVAD();
        }
        break;

      case "error":
        showError(msg.message || "An error occurred.");
        setOrbState("listening");
        setStatus("Listening…");
        isSpeaking = false;
        startVAD();
        break;

      default:
        console.log("ws_voice: unknown action", msg.action);
    }
  }

  // ── Audio playback ────────────────────────────────────────────
  function playAudioResponse(base64Data, format) {
    try {
      const binary  = atob(base64Data);
      const bytes   = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const mimeMap = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" };
      const mime    = mimeMap[format] || "audio/wav";
      const blob    = new Blob([bytes], { type: mime });
      const url     = URL.createObjectURL(blob);

      const audio   = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        isSpeaking = false;
        // Restart listening after AI finishes speaking
        setOrbState("listening");
        setStatus("Listening…");
        startVAD();
      };
      audio.onerror = (e) => {
        console.error("Audio playback error", e);
        URL.revokeObjectURL(url);
        isSpeaking = false;
        setOrbState("listening");
        setStatus("Listening…");
        startVAD();
      };
      audio.play().catch((e) => {
        console.error("audio.play() rejected:", e);
        isSpeaking = false;
        setOrbState("listening");
        setStatus("Listening…");
        startVAD();
      });
    } catch (err) {
      console.error("playAudioResponse error:", err);
      isSpeaking = false;
      setOrbState("listening");
      setStatus("Listening…");
      startVAD();
    }
  }

  // ── VAD (Voice Activity Detection) ───────────────────────────
  function startVAD() {
    if (vadActive || !analyser) return;
    vadActive        = true;
    speechStartTime  = null;
    silenceStartTime = null;
    vadLoop();
  }

  function stopVAD() {
    vadActive = false;
    if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null; }
    if (isRecording) stopRecording();
  }

  function vadLoop() {
    if (!vadActive) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray    = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(dataArray);

    // RMS energy
    let sumSq = 0;
    for (let i = 0; i < bufferLength; i++) sumSq += dataArray[i] * dataArray[i];
    const rms   = Math.sqrt(sumSq / bufferLength);
    const now   = performance.now();
    const loud  = rms > VAD_ENERGY_THRESHOLD;

    if (loud) {
      silenceStartTime = null;
      if (!isRecording) {
        if (speechStartTime === null) {
          speechStartTime = now;
        } else if (now - speechStartTime >= VAD_SPEECH_MIN_MS) {
          startRecording();
        }
      }
    } else {
      speechStartTime = null;
      if (isRecording) {
        if (silenceStartTime === null) {
          silenceStartTime = now;
        } else if (now - silenceStartTime >= VAD_SILENCE_MIN_MS) {
          stopRecording();
          return; // VAD will restart via server "listening" message
        }
      }
    }

    vadRafId = requestAnimationFrame(vadLoop);
  }

  // ── MediaRecorder ─────────────────────────────────────────────
  function startRecording() {
    if (isRecording || !mediaStream) return;
    isRecording    = true;
    recordedChunks = [];

    // Prefer webm/opus; fall back to whatever is supported
    const mimeType = getSupportedMimeType();
    const options  = mimeType ? { mimeType } : {};

    try {
      mediaRecorder = new MediaRecorder(mediaStream, options);
    } catch (err) {
      console.error("MediaRecorder creation failed:", err);
      isRecording = false;
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      isRecording = false;
      if (!vadActive) return; // session was stopped

      const blob = new Blob(recordedChunks, { type: mimeType || "audio/webm" });
      recordedChunks = [];

      if (blob.size < 100) {
        // Too small — likely noise, ask server to keep listening
        wsSend({ action: "listening" });
        return;
      }

      try {
        const b64 = await blobToBase64(blob);
        // Stop VAD while we wait for the server round-trip
        stopVAD();
        wsSend({ action: "audio", data: b64 });
      } catch (err) {
        console.error("blobToBase64 error:", err);
        setOrbState("listening");
        setStatus("Listening…");
        startVAD();
      }
    };

    mediaRecorder.start();
    console.log("VAD: recording started");
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    // We don't set isRecording=false here — onstop callback does it
    try { mediaRecorder.stop(); } catch (e) { /* already stopped */ }
    console.log("VAD: recording stopped (silence detected)");
  }

  function getSupportedMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  // ── Utility ───────────────────────────────────────────────────
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => {
        // result is "data:<mime>;base64,<data>"
        const b64 = reader.result.split(",")[1];
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── Start / Stop buttons ──────────────────────────────────────
  btnStart.addEventListener("click", async () => {
    btnStart.disabled = true;

    // Request microphone
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      showError("Microphone access denied. Please allow mic access and try again.");
      btnStart.disabled = false;
      return;
    }

    // Build AudioContext for VAD
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    const source = audioCtx.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    // Show stop button
    btnStart.style.display = "none";
    btnStop.style.display  = "inline-block";

    setOrbState("idle");
    setStatus("Connecting…");

    openWebSocket();
  });

  btnStop.addEventListener("click", () => {
    stopAll();
  });

  function stopAll() {
    // Stop VAD
    stopVAD();

    // Send stop to server
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ action: "stop" });
      ws.close();
    }
    ws = null;

    // Stop mic tracks
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }

    // Close AudioContext
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
      analyser = null;
    }

    // Reset UI
    isSpeaking  = false;
    isRecording = false;
    setOrbState("idle");
    setStatus("Tap Start to begin");
    btnStop.style.display  = "none";
    btnStart.style.display = "inline-block";
    btnStart.disabled      = false;
  }

})();
