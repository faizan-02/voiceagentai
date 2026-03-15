/**
 * enhanced.js — browser-based voice chat using /ws_voice
 * Same MediaRecorder + VAD approach as scripts.js, with enhanced settings.
 */
document.addEventListener("DOMContentLoaded", function() {

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const micIcon              = document.getElementById('mic-icon');
    const themeToggle          = document.getElementById('theme-toggle');
    const downloadButton       = document.getElementById('download-button');
    const conversation         = document.getElementById('conversation');
    const messagesDiv          = document.getElementById('messages');
    const startBtn             = document.getElementById('startBtn');
    const stopBtn              = document.getElementById('stopBtn');
    const clearBtn             = document.getElementById('clearBtn');
    const characterSelect      = document.getElementById('characterSelect');
    const voiceSelect          = document.getElementById('voiceSelect');
    const modelSelect          = document.getElementById('modelSelect');
    const statusBar            = document.getElementById('status-bar-enhanced');

    // ── State ─────────────────────────────────────────────────────────────────
    let websocket              = null;
    let mediaStream            = null;
    let mediaRecorder          = null;
    let audioChunks            = [];
    let audioContext           = null;
    let analyser               = null;
    let vadTimer               = null;
    let isConversationActive   = false;
    let currentAudio           = null;
    let audioResponseReceived  = false;
    let checkInTimer            = null;
    let vadReady                = false;
    const CHECK_IN_MS           = 10000;

    // VAD tuning
    const SILENCE_THRESHOLD    = 15;   // 15/255 — filters noise while catching speech
    const SILENCE_DURATION_MS  = 1800;
    const MIN_SPEECH_CHUNKS    = 3;    // 300ms confirmed speech required
    const MAX_RECORD_MS        = 12000;
    let silenceStart   = null;
    let speechChunks   = 0;
    let hasSpeech      = false;
    let recordingStart = null;

    // ── Agent state ───────────────────────────────────────────────────────────

    function setStatus(state) {
        if (!statusBar) return;
        const icons  = { idle: '○', listening: '◉', thinking: '◌', speaking: '▶', goodbye: '✓' };
        const labels = {
            idle:      'Ready — press Start to begin',
            listening: 'Listening…',
            thinking:  'Thinking…',
            speaking:  'Speaking…',
            goodbye:   'Conversation ended'
        };
        statusBar.className = 'status-bar status-' + state;
        statusBar.innerHTML =
            `<span class="status-dot">${icons[state] || '○'}</span>` +
            `<span class="status-label">${labels[state] || ''}</span>`;

        // Mic icon
        micIcon.classList.remove('mic-on', 'mic-off', 'mic-waiting', 'pulse-animation');
        if      (state === 'listening') micIcon.classList.add('mic-on', 'pulse-animation');
        else if (state === 'thinking')  micIcon.classList.add('mic-waiting');
        else if (state === 'speaking')  micIcon.classList.add('mic-on');
        else                            micIcon.classList.add('mic-off');

        // Buttons
        const active = (state !== 'idle' && state !== 'goodbye');
        startBtn.disabled = active;
        stopBtn.disabled  = !active;
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────

    function connectWebSocket() {
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        websocket = new WebSocket(`${wsProto}://${window.location.host}/ws_voice`);

        websocket.onopen = function() {
            websocket.send(JSON.stringify({
                action:    "start",
                character: characterSelect.value,
                model:     modelSelect.value,
                voice:     voiceSelect.value
            }));
        };

        websocket.onclose = function() {
            stopVAD();
            if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
            if (isConversationActive) { isConversationActive = false; setStatus('idle'); }
        };

        websocket.onerror = function() {
            displayMessage("Connection error. Please try again.", 'error-message');
            isConversationActive = false;
            setStatus('idle');
        };

        websocket.onmessage = handleMessage;
    }

    function handleMessage(event) {
        let data;
        try { data = JSON.parse(event.data); }
        catch (e) { return; }

        switch (data.action) {
            case "listening":
                setStatus('listening');
                hideThinking();
                hideVoiceAnim();
                showListening();
                audioResponseReceived = false;
                startRecording();
                break;
            case "transcript":
                hideListening();
                if (data.text) displayMessage(data.text, 'user-message');
                break;
            case "thinking":
                setStatus('thinking');
                hideListening();
                showThinking();
                break;
            case "response_text":
                hideThinking();
                if (data.text) displayMessage(data.text, 'ai-message');
                break;
            case "audio_response":
                audioResponseReceived = true;
                setStatus('speaking');
                showVoiceAnim();
                playAudio(data.data, data.format || 'mp3');
                break;
            case "done":
                if (!audioResponseReceived) nextTurn();
                break;
            case "error":
                displayMessage(data.message || "Error occurred.", 'error-message');
                hideThinking(); hideListening(); hideVoiceAnim();
                if (isConversationActive) setTimeout(nextTurn, 1200);
                break;
        }
    }

    function nextTurn() {
        if (!isConversationActive || !websocket || websocket.readyState !== WebSocket.OPEN) return;
        audioResponseReceived = false;
        setStatus('listening');
        showListening();
        startRecording();
    }

    // ── Microphone ────────────────────────────────────────────────────────────

    async function initMic() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const src = audioContext.createMediaStreamSource(mediaStream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            return true;
        } catch (e) {
            displayMessage("Microphone access denied.", 'error-message');
            return false;
        }
    }

    // ── Recording + VAD ───────────────────────────────────────────────────────

    function getMimeType() {
        const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
        for (const t of types) { if (!t || MediaRecorder.isTypeSupported(t)) return t; }
        return '';
    }

    function startRecording() {
        if (!mediaStream || !isConversationActive) return;
        audioChunks    = [];
        hasSpeech      = false;
        silenceStart   = null;
        speechChunks   = 0;
        recordingStart = Date.now();

        const mt = getMimeType();
        try { mediaRecorder = new MediaRecorder(mediaStream, mt ? { mimeType: mt } : {}); }
        catch (_) { mediaRecorder = new MediaRecorder(mediaStream); }

        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.start(100);
        vadTimer = setInterval(checkVAD, 100);
    }

    // ── Check-in timer (independent of VAD) ──────────────────────────────────

    function resetCheckInTimer() {
        clearTimeout(checkInTimer);
        if (!isConversationActive) return;
        checkInTimer = setTimeout(fireCheckIn, CHECK_IN_MS);
    }

    function fireCheckIn() {
        if (!isConversationActive || !websocket || websocket.readyState !== WebSocket.OPEN) return;
        stopVAD();
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.onstop = () => {
                audioChunks = [];
                websocket.send(JSON.stringify({ action: "check_in" }));
            };
            mediaRecorder.stop();
        } else {
            websocket.send(JSON.stringify({ action: "check_in" }));
        }
    }

    function checkVAD() {
        if (!analyser || !isConversationActive || !vadReady) return;
        const buf = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length;
        const now = Date.now();

        if (avg > SILENCE_THRESHOLD) {
            silenceStart = null; hasSpeech = true; speechChunks++;
        } else {
            if (hasSpeech) {
                if (!silenceStart) silenceStart = now;
                if (now - silenceStart > SILENCE_DURATION_MS) submitRecording();
            } else if (now - recordingStart > MAX_RECORD_MS) {
                submitRecording();
            }
        }
    }

    function submitRecording() {
        stopVAD();
        if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

        mediaRecorder.onstop = async () => {
            if (hasSpeech && speechChunks >= MIN_SPEECH_CHUNKS && audioChunks.length > 0) {
                resetCheckInTimer();
                const blob   = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                const ab     = await blob.arrayBuffer();
                const b64    = arrayBufferToBase64(ab);
                audioChunks  = [];
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    hideListening();
                    setStatus('thinking');
                    showThinking();
                    websocket.send(JSON.stringify({ action: "audio", data: b64 }));
                }
            } else {
                audioChunks = [];
                if (isConversationActive) nextTurn();
            }
        };
        mediaRecorder.stop();
    }

    function stopVAD() { if (vadTimer) { clearInterval(vadTimer); vadTimer = null; } }

    function stopRecording() {
        stopVAD();
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onstop = null;
            try { mediaRecorder.stop(); } catch (_) {}
        }
        audioChunks = [];
    }

    function arrayBufferToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk)
            bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        return btoa(bin);
    }

    // ── Playback ──────────────────────────────────────────────────────────────

    function playAudio(b64, format) {
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        const str   = atob(b64);
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
        const blob  = new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : `audio/${format}` });
        const url   = URL.createObjectURL(blob);
        currentAudio = new Audio(url);

        currentAudio.onended = () => {
            URL.revokeObjectURL(url); currentAudio = null;
            hideVoiceAnim();
            resetCheckInTimer(); // restart 10s clock after AI finishes speaking
            nextTurn();
        };
        currentAudio.onerror = () => {
            URL.revokeObjectURL(url); currentAudio = null;
            hideVoiceAnim(); nextTurn();
        };
        currentAudio.play().catch(() => { hideVoiceAnim(); nextTurn(); });
    }

    // ── Buttons ───────────────────────────────────────────────────────────────

    startBtn.addEventListener('click', async function() {
        if (isConversationActive) return;
        const ok = await initMic();
        if (!ok) return;
        isConversationActive = true;
        vadReady = false;
        setStatus('listening');
        connectWebSocket();
        setTimeout(() => {
            vadReady = true;
            resetCheckInTimer();
        }, 2000);
    });

    stopBtn.addEventListener('click', function() {
        isConversationActive = false;
        vadReady = false;
        clearTimeout(checkInTimer);
        stopVAD(); stopRecording();
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            try { websocket.send(JSON.stringify({ action: "stop" })); } catch (_) {}
            websocket.close();
        }
        if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
        hideListening(); hideThinking(); hideVoiceAnim();
        setStatus('goodbye');
        displayMessage("Conversation ended.", 'goodbye-message');
        setTimeout(() => setStatus('idle'), 3000);
    });

    clearBtn.addEventListener('click', function() {
        messagesDiv.innerHTML = '';
        fetch('/clear_history', { method: 'POST' }).catch(() => {});
        displayMessage("Conversation cleared.", 'system-message');
    });

    // ── Indicators ────────────────────────────────────────────────────────────

    function showListening() {
        hideListening();
        const el = document.createElement('div');
        el.id = 'listening-indicator'; el.className = 'listening-indicator';
        el.innerHTML = 'Listening <div class="listening-dots">' +
            '<div class="dot"></div>' +
            '<div class="dot" style="animation-delay:0.2s"></div>' +
            '<div class="dot" style="animation-delay:0.4s"></div></div>';
        messagesDiv.appendChild(el);
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideListening() { const e = document.getElementById('listening-indicator'); if (e) e.remove(); }

    function showThinking() {
        hideThinking();
        const el = document.createElement('div');
        el.id = 'thinking-indicator'; el.className = 'thinking-indicator';
        el.innerHTML = 'Thinking <div class="thinking-dots">' +
            '<div class="dot"></div>' +
            '<div class="dot" style="animation-delay:0.2s"></div>' +
            '<div class="dot" style="animation-delay:0.4s"></div></div>';
        messagesDiv.appendChild(el);
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideThinking() { const e = document.getElementById('thinking-indicator'); if (e) e.remove(); }

    function showVoiceAnim() {
        const v = document.getElementById('voiceWaveAnimation');
        if (v) v.classList.remove('hidden');
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideVoiceAnim() {
        const v = document.getElementById('voiceWaveAnimation');
        if (v) v.classList.add('hidden');
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    function displayMessage(text, className) {
        text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (!text) return;
        const el = document.createElement('div');
        if (className) {
            el.className = className;
        } else if (text.startsWith('You:')) {
            el.className = 'user-message';
            text = text.replace('You:', '').trim();
        } else {
            el.className = 'ai-message';
        }
        if (text.includes('\n')) {
            text.split('\n').forEach((line, i) => {
                if (i > 0) el.appendChild(document.createElement('br'));
                el.appendChild(document.createTextNode(line));
            });
        } else {
            el.textContent = text;
        }
        messagesDiv.appendChild(el);
        setTimeout(() => { conversation.scrollTop = conversation.scrollHeight; }, 10);
    }

    // ── Characters ────────────────────────────────────────────────────────────

    fetch('/characters')
        .then(r => r.json())
        .then(data => {
            characterSelect.innerHTML = '';
            (data.characters || []).sort((a, b) => a.localeCompare(b)).forEach(c => {
                const opt = document.createElement('option');
                opt.value = c; opt.textContent = c.replace(/_/g, ' ');
                characterSelect.appendChild(opt);
            });
            // Default to customer_support if available
            const opts = [...characterSelect.options].map(o => o.value);
            if (opts.includes('customer_support')) characterSelect.value = 'customer_support';
        })
        .catch(() => {});

    characterSelect.addEventListener('change', function() {
        messagesDiv.innerHTML = '';
        fetch('/set_character', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ character: this.value })
        }).catch(() => {});
    });

    // ── Theme ─────────────────────────────────────────────────────────────────

    function updateThemeIcon() {
        const dark = document.body.classList.contains('dark-mode');
        themeToggle.innerHTML = dark
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }

    themeToggle.addEventListener('click', function() {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem('darkMode', document.body.classList.contains('dark-mode'));
        updateThemeIcon();
    });

    const stored = localStorage.getItem('darkMode');
    if (stored !== null) document.body.classList.toggle('dark-mode', stored === 'true');
    else document.body.classList.add('dark-mode');
    updateThemeIcon();

    // ── Download ──────────────────────────────────────────────────────────────

    downloadButton.addEventListener('click', async function() {
        const r = await fetch('/download_history');
        if (r.ok) {
            const blob = await r.blob();
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url; a.download = 'conversation_history.txt'; a.click();
            URL.revokeObjectURL(url);
        }
    });

    // ── Init ──────────────────────────────────────────────────────────────────
    setStatus('idle');
    stopBtn.disabled = true;
});
