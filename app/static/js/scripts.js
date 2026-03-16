document.addEventListener("DOMContentLoaded", function() {
    // ─── DOM refs ─────────────────────────────────────────────────────────────
    const themeToggle        = document.getElementById('theme-toggle');
    const downloadButton     = document.getElementById('download-button');
    const body               = document.body;
    const voiceAnimation     = document.getElementById('voice-animation');
    const startButton        = document.getElementById('start-conversation-btn');
    const stopButton         = document.getElementById('stop-conversation-btn');
    const clearButton        = document.getElementById('clear-conversation-btn');
    const messages           = document.getElementById('messages');
    const micIcon            = document.getElementById('mic-icon');
    const characterSelect    = document.getElementById('character-select');
    const providerSelect     = document.getElementById('provider-select');
    const ttsSelect          = document.getElementById('tts-select');
    const openaiVoiceSelect  = document.getElementById('openai-voice-select');
    const statusBar          = document.getElementById('status-bar');
    const elevenLabsVoiceSelect = document.getElementById('elevenlabs-voice-select');
    const kokoroVoiceSelect  = document.getElementById('kokoro-voice-select');
    const openaiModelSelect  = document.getElementById('openai-model-select');
    const ollamaModelSelect  = document.getElementById('ollama-model-select');
    const xaiModelSelect     = document.getElementById('xai-model-select');
    const voiceSpeedSelect   = document.getElementById('voice-speed-select');
    const transcriptionSelect = document.getElementById('transcription-select');

    // Set initial TTS from server-rendered attribute
    const initialTTS = ttsSelect.dataset.initial;
    if (initialTTS && initialTTS !== 'None' && initialTTS !== '') ttsSelect.value = initialTTS;

    // ─── Runtime state ────────────────────────────────────────────────────────
    let agentState           = 'idle';
    let thinkingTimeout      = null; // safety: escape "thinking" state if server never responds
    let websocket            = null;
    let mediaStream          = null;
    let mediaRecorder        = null;
    let audioChunks          = [];
    let audioContext         = null;
    let analyser             = null;
    let vadTimer             = null;  // kept for compat with stopVAD()
    let vadActive            = false; // chunk-based VAD gate
    let isConversationActive = false;
    let currentAudio         = null;
    let audioResponseReceived = false;
    let checkInTimer          = null;
    let vadReady              = false; // suppressed during echo dead-zone after AI speaks
    const CHECK_IN_MS         = 15000;

    // Booking state
    let bookingDetails = { date: null, time: null, services: [] };

    // VAD tuning — chunk-size based (opus encodes silence tiny, speech large)
    const SPEECH_CHUNK_BYTES  = 400;  // bytes/100ms: silence~50-250, speech~400+
    const SILENCE_DURATION_MS = 2000; // ms of sub-threshold chunks before submitting
    const MIN_SPEECH_CHUNKS   = 3;    // 300ms of speech-sized chunks before we consider it real
    const MAX_RECORD_MS       = 8000; // hard cut-off — submit after 8s regardless
    const MIN_AUDIO_BYTES     = 1000; // reject blobs that are clearly empty
    const ECHO_DEAD_ZONE_MS   = 1500; // ms post-AI-speech before VAD activates
    let silenceStart  = null;
    let speechChunks  = 0;
    let hasSpeech     = false;
    let recordingStart = null;

    // Populate dropdowns on load
    fetchCharacters();
    if (providerSelect.value === 'ollama') fetchOllamaModels();

    // ─── Agent state machine ──────────────────────────────────────────────────

    function setAgentState(state) {
        agentState = state;
        // Suppress check-in timer while AI is thinking or speaking
        if (state === 'thinking' || state === 'speaking') {
            clearTimeout(checkInTimer);
            checkInTimer = null;
        }
        // Safety timeout: if stuck thinking for 30s with no server response, restart
        clearTimeout(thinkingTimeout);
        if (state === 'thinking') {
            thinkingTimeout = setTimeout(() => {
                if (agentState === 'thinking' && isConversationActive) {
                    console.warn('Thinking timeout — restarting turn');
                    hideThinkingIndicator();
                    startNextTurn();
                }
            }, 30000);
        }
        updateStatusBar();
        updateButtonStates();
        updateMicIcon();
    }

    function updateStatusBar() {
        if (!statusBar) return;
        statusBar.className = 'status-bar status-' + agentState;
        const icons  = { idle: '○', listening: '◉', thinking: '◌', speaking: '▶', goodbye: '✓' };
        const labels = {
            idle:      'Ready — press Start to begin',
            listening: 'Listening…',
            thinking:  'Thinking…',
            speaking:  'Speaking…',
            goodbye:   'Conversation ended'
        };
        statusBar.innerHTML =
            `<span class="status-dot">${icons[agentState] || '○'}</span>` +
            `<span class="status-label">${labels[agentState] || ''}</span>`;
    }

    function updateButtonStates() {
        const active = (agentState !== 'idle' && agentState !== 'goodbye');
        startButton.disabled = active;
        stopButton.disabled  = !active;
        startButton.classList.toggle('btn-active',        !active);
        stopButton.classList.toggle('btn-danger-active',   active);
    }

    function updateMicIcon() {
        micIcon.classList.remove('mic-on', 'mic-off', 'mic-waiting', 'pulse-animation');
        if      (agentState === 'listening') micIcon.classList.add('mic-on', 'pulse-animation');
        else if (agentState === 'thinking')  micIcon.classList.add('mic-waiting');
        else if (agentState === 'speaking')  micIcon.classList.add('mic-on');
        else                                 micIcon.classList.add('mic-off');
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    function connectWebSocket() {
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        websocket = new WebSocket(`${wsProto}://${window.location.host}/ws_voice`);

        websocket.onopen = function() {
            console.log("ws_voice: connected");
            websocket.send(JSON.stringify({
                action:    "start",
                character: characterSelect.value,
                model:     getSelectedModel(),
                voice:     openaiVoiceSelect.value
            }));
        };

        websocket.onclose = function() {
            console.log("ws_voice: closed");
            stopVAD();
            if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
            if (isConversationActive) { isConversationActive = false; setAgentState('idle'); }
        };

        websocket.onerror = function(err) {
            console.error("ws_voice error:", err);
            displayMessage("Connection error. Please try again.", 'error-message');
            isConversationActive = false;
            setAgentState('idle');
        };

        websocket.onmessage = handleServerMessage;
    }

    function handleServerMessage(event) {
        let data;
        try { data = JSON.parse(event.data); }
        catch (e) { console.error("Bad JSON:", event.data); return; }

        switch (data.action) {

            case "listening":
                setAgentState('listening');
                hideThinkingIndicator();
                hideVoiceAnimation();
                showListeningIndicator();
                audioResponseReceived = false;
                startRecording();
                break;

            case "transcript":
                hideListeningIndicator();
                if (data.text) displayMessage(data.text, 'user-message');
                break;

            case "thinking":
                setAgentState('thinking');
                hideListeningIndicator();
                showThinkingIndicator();
                break;

            case "response_text":
                hideThinkingIndicator();
                if (data.text) displayMessage(data.text, 'ai-message');
                break;

            case "audio_response":
                audioResponseReceived = true;
                setAgentState('speaking');
                showVoiceAnimation();
                playAudioResponse(data.data, data.format || 'mp3');
                break;

            case "done":
                // If no audio arrived (e.g. TTS error path), start next turn now.
                // Otherwise audio.onended handles the next turn.
                if (!audioResponseReceived) {
                    startNextTurn();
                }
                break;

            case "error": {
                const msg = data.message || "An error occurred.";
                console.error("Server error:", msg);
                const isAudioQualityErr = msg.toLowerCase().includes('corrupted') ||
                                          msg.toLowerCase().includes('unsupported') ||
                                          msg.toLowerCase().includes("didn't catch");
                if (!isAudioQualityErr) {
                    displayMessage(`⚠ ${msg}`, 'error-message');
                }
                hideThinkingIndicator();
                hideListeningIndicator();
                hideVoiceAnimation();
                if (isConversationActive) {
                    // Shorter delay for audio quality errors — just restart quietly
                    setTimeout(startNextTurn, isAudioQualityErr ? 400 : 1500);
                }
                break;
            }

            case "booking_update":
                // Server extracted date/service/time from user speech — sync the UI
                if (data.date)    { bookingDetails.date = data.date; syncCalendarDate(data.date); }
                if (data.service) { syncServiceSelection(data.service, data.service_price || '', data.service_duration || ''); }
                if (data.time)    { bookingDetails.time = data.time; syncTimeSelection(data.time); }
                break;

            case "booking_confirmed":
                showBookingSummary();
                break;

            case "conversation_ended":
                // Sara said goodbye — end the session after her audio finishes
                if (currentAudio) {
                    currentAudio.onended = () => {
                        URL.revokeObjectURL(currentAudio ? currentAudio.src : '');
                        currentAudio = null;
                        hideVoiceAnimation();
                        endConversation();
                    };
                } else {
                    setTimeout(endConversation, 500);
                }
                break;
        }
    }

    function startNextTurn() {
        if (!isConversationActive) return;
        if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
        if (currentAudio) return; // audio still playing — onended will call us
        audioResponseReceived = false;
        setAgentState('listening');
        showListeningIndicator();
        startRecording();
    }

    // ─── Microphone init ──────────────────────────────────────────────────────

    async function initMicrophone() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(mediaStream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            return true;
        } catch (err) {
            console.error("Mic error:", err);
            displayMessage("Microphone access denied. Please allow microphone access and try again.", 'error-message');
            return false;
        }
    }

    // ─── Recording + VAD ─────────────────────────────────────────────────────

    function getSupportedMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            ''
        ];
        for (const t of types) {
            if (!t || MediaRecorder.isTypeSupported(t)) return t;
        }
        return '';
    }

    function startRecording() {
        if (!mediaStream || !isConversationActive) return;

        audioChunks    = [];
        hasSpeech      = false;
        silenceStart   = null;
        speechChunks   = 0;
        recordingStart = Date.now();

        const mimeType = getSupportedMimeType();
        try {
            mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
        } catch (e) {
            mediaRecorder = new MediaRecorder(mediaStream);
        }

        let chunkIndex = 0;
        vadActive = true;

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
            if (!vadActive || !vadReady || !isConversationActive) return;

            chunkIndex++;
            if (chunkIndex <= 2) return; // skip first 200ms — WebM container header is oversized

            const now = Date.now();

            // Opus chunk-size VAD:
            // Silence compresses to ~50-250 bytes/100ms; speech compresses to 400+ bytes.
            // This works regardless of AudioContext state, mic gain, or browser version.
            if (e.data.size >= SPEECH_CHUNK_BYTES) {
                silenceStart = null;
                hasSpeech    = true;
                speechChunks++;
            } else {
                if (hasSpeech) {
                    if (!silenceStart) silenceStart = now;
                    if (now - silenceStart > SILENCE_DURATION_MS) submitRecording();
                } else if (now - recordingStart > MAX_RECORD_MS) {
                    submitRecording();
                }
            }
        };

        mediaRecorder.start(100);

        if (vadReady) resetCheckInTimer();
    }

    // ─── Check-in timer (independent of VAD) ─────────────────────────────────
    // Fires 10s after the last confirmed speech / AI response / conversation start

    function resetCheckInTimer() {
        clearTimeout(checkInTimer);
        if (!isConversationActive) return;
        checkInTimer = setTimeout(fireCheckIn, CHECK_IN_MS);
    }

    function fireCheckIn() {
        // Only fire when truly idle-listening — never interrupt AI speaking/thinking
        if (!isConversationActive || agentState !== 'listening') return;
        if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
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

    function submitRecording() {
        stopVAD();
        if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

        mediaRecorder.onstop = async () => {
            if (hasSpeech && speechChunks >= MIN_SPEECH_CHUNKS && audioChunks.length > 0) {
                const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                audioChunks = [];

                // Skip near-silence blobs — Whisper rejects them with 400
                if (blob.size < MIN_AUDIO_BYTES) {
                    if (isConversationActive) startNextTurn();
                    return;
                }

                const arrayBuf = await blob.arrayBuffer();
                const base64   = arrayBufferToBase64(arrayBuf);

                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    hideListeningIndicator();
                    setAgentState('thinking');
                    showThinkingIndicator();
                    websocket.send(JSON.stringify({ action: "audio", data: base64 }));
                }
            } else {
                // No speech this round — just restart listening
                audioChunks = [];
                if (isConversationActive) startNextTurn();
            }
        };

        mediaRecorder.stop();
    }

    function stopRecording() {
        stopVAD();
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.ondataavailable = null;
            mediaRecorder.onstop = null;
            try { mediaRecorder.stop(); } catch (_) {}
        }
        audioChunks = [];
    }

    function stopVAD() {
        vadActive = false;
        if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let bin = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(bin);
    }

    // ─── Audio playback ───────────────────────────────────────────────────────

    function playAudioResponse(base64Data, format) {
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }

        const byteStr = atob(base64Data);
        const bytes   = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);

        const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;
        const blob     = new Blob([bytes], { type: mimeType });
        const url      = URL.createObjectURL(blob);

        currentAudio = new Audio(url);
        currentAudio.playbackRate = parseFloat(voiceSpeedSelect.value) || 1.0;

        function afterAudioEnds() {
            currentAudio = null;
            hideVoiceAnimation();
            // Echo dead-zone: suppress VAD for ECHO_DEAD_ZONE_MS after AI speech ends.
            // Room reverb / speaker echo would trigger false speech detection without this.
            vadReady = false;
            startNextTurn(); // MediaRecorder starts now, VAD stays off until dead-zone expires
            setTimeout(() => {
                if (isConversationActive) {
                    vadReady = true;
                    if (agentState === 'listening') resetCheckInTimer();
                }
            }, ECHO_DEAD_ZONE_MS);
        }

        currentAudio.onended = () => {
            URL.revokeObjectURL(url);
            afterAudioEnds();
        };

        currentAudio.onerror = (e) => {
            console.error("Playback error:", e);
            URL.revokeObjectURL(url);
            afterAudioEnds();
        };

        currentAudio.play().catch(e => {
            console.error("play() rejected:", e);
            URL.revokeObjectURL(url);
            afterAudioEnds();
        });
    }

    // ─── Button actions ───────────────────────────────────────────────────────

    startButton.addEventListener('click', async function() {
        if (isConversationActive) return;

        const ok = await initMicrophone();
        if (!ok) return;

        isConversationActive = true;
        vadReady = false;
        setAgentState('listening');
        connectWebSocket();
        // 800ms warmup: AudioContext needs a moment before getByteTimeDomainData is reliable
        setTimeout(() => {
            vadReady = true;
            if (isConversationActive && agentState === 'listening') resetCheckInTimer();
        }, 800);
    });

    function endConversation() {
        if (!isConversationActive && agentState === 'idle') return;
        isConversationActive = false;
        vadReady = false;
        clearTimeout(checkInTimer);
        stopVAD();
        stopRecording();
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            try { websocket.send(JSON.stringify({ action: "stop" })); } catch (_) {}
            websocket.close();
        }
        if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
        hideListeningIndicator();
        hideThinkingIndicator();
        hideVoiceAnimation();
        setAgentState('goodbye');
        displayMessage("Conversation ended.", 'goodbye-message');
        setTimeout(() => setAgentState('idle'), 3000);
        bookingDetails = { date: null, time: null, services: [] };
        document.querySelectorAll('.spa-service-item').forEach(i => i.classList.remove('selected'));
        document.querySelectorAll('.spa-time-slot').forEach(i => i.classList.remove('selected'));
        const doneWrap = document.getElementById('service-done-wrap');
        if (doneWrap) doneWrap.style.display = 'none';
        const summarySection = document.getElementById('booking-summary-section');
        if (summarySection) summarySection.style.display = 'none';
    }

    stopButton.addEventListener('click', endConversation);

    clearButton.addEventListener('click', async function() {
        messages.innerHTML = '';
        try {
            await fetch('/clear_history', { method: 'POST' });
            displayMessage("Conversation history cleared.", "system-message");
        } catch (_) {
            displayMessage("Error clearing conversation history.", "error-message");
        }
    });

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function getSelectedModel() {
        const provider = providerSelect.value;
        if (provider === 'openai')    return openaiModelSelect.value;
        if (provider === 'ollama')    return ollamaModelSelect.value;
        if (provider === 'xai')       return xaiModelSelect.value;
        if (provider === 'anthropic') {
            const el = document.getElementById('anthropic-model-select');
            return el ? el.value : 'claude-sonnet-4-6';
        }
        return openaiModelSelect.value;
    }

    // ─── Indicators ───────────────────────────────────────────────────────────

    function showListeningIndicator() {
        hideListeningIndicator();
        const el = document.createElement('div');
        el.className = 'listening-indicator';
        el.id = 'listening-indicator';
        el.innerHTML = 'Listening <div class="listening-dots">' +
            '<div class="dot"></div>' +
            '<div class="dot" style="animation-delay:0.2s"></div>' +
            '<div class="dot" style="animation-delay:0.4s"></div></div>';
        messages.appendChild(el);
        scrollToBottom();
    }

    function hideListeningIndicator() {
        const el = document.getElementById('listening-indicator');
        if (el) el.remove();
    }

    function showThinkingIndicator() {
        hideThinkingIndicator();
        const el = document.createElement('div');
        el.className = 'thinking-indicator';
        el.id = 'thinking-indicator';
        el.innerHTML = 'Thinking <div class="thinking-dots">' +
            '<div class="dot"></div>' +
            '<div class="dot" style="animation-delay:0.2s"></div>' +
            '<div class="dot" style="animation-delay:0.4s"></div></div>';
        messages.appendChild(el);
        scrollToBottom();
    }

    function hideThinkingIndicator() {
        const el = document.getElementById('thinking-indicator');
        if (el) el.remove();
    }

    function showVoiceAnimation() {
        voiceAnimation.classList.remove('hidden');
        scrollToBottom();
    }

    function hideVoiceAnimation() {
        voiceAnimation.classList.add('hidden');
        setTimeout(scrollToBottom, 100);
    }

    function scrollToBottom() {
        const conv = document.getElementById('conversation');
        if (conv) conv.scrollTop = conv.scrollHeight;
    }

    // ─── Message display ──────────────────────────────────────────────────────

    function displayMessage(message, className) {
        let text = String(message).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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

        if (text.includes('```')) {
            text.split(/(```(?:.*?)```)/gs).forEach(seg => {
                if (seg.startsWith('```') && seg.endsWith('```')) {
                    const pre  = document.createElement('pre');
                    const code = document.createElement('code');
                    code.textContent = seg.slice(3, -3).trim();
                    pre.appendChild(code);
                    el.appendChild(pre);
                } else if (seg.trim()) {
                    seg.split('\n').forEach((line, i) => {
                        if (i > 0) el.appendChild(document.createElement('br'));
                        el.appendChild(document.createTextNode(line));
                    });
                }
            });
        } else if (text.includes('\n')) {
            text.split('\n').forEach((line, i) => {
                if (i > 0) el.appendChild(document.createElement('br'));
                el.appendChild(document.createTextNode(line));
            });
        } else {
            el.textContent = text;
        }

        messages.appendChild(el);
        setTimeout(scrollToBottom, 10);
    }

    // ─── Characters ───────────────────────────────────────────────────────────

    function fetchCharacters() {
        fetch('/characters')
            .then(r => r.json())
            .then(data => populateCharacterSelect(data.characters))
            .catch(err => console.error('Error fetching characters:', err));
    }

    function populateCharacterSelect(characters) {
        characterSelect.innerHTML = '';
        characters.sort((a, b) => a.localeCompare(b)).forEach(character => {
            const opt = document.createElement('option');
            opt.value = character;
            opt.textContent = character.replace(/_/g, ' ');
            characterSelect.appendChild(opt);
        });
        const defaultChar = document.querySelector('meta[name="default-character"]')?.getAttribute('content');
        if (defaultChar && characters.includes(defaultChar)) {
            characterSelect.value = defaultChar;
        } else if (characters.length > 0) {
            characterSelect.value = characters[0];
        }
        toggleSpaSidebar(characterSelect.value);
    }

    characterSelect.addEventListener('change', function() {
        const ch = this.value;
        toggleSpaSidebar(ch);
        messages.innerHTML = '';
        fetch('/set_character', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ character: ch })
        }).catch(err => console.error('Error setting character:', err));
    });

    // ─── Ollama models ────────────────────────────────────────────────────────

    function fetchOllamaModels() {
        fetch('/ollama_models')
            .then(r => r.json())
            .then(data => { if (data.models?.length) populateOllamaModelSelect(data.models); })
            .catch(err => console.error('Error fetching Ollama models:', err));
    }

    function populateOllamaModelSelect(models) {
        const current = ollamaModelSelect.value;
        ollamaModelSelect.innerHTML = '';
        models.sort((a, b) => a.localeCompare(b)).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            ollamaModelSelect.appendChild(opt);
        });
        if (models.includes(current)) ollamaModelSelect.value = current;
        else if (models.includes('llama3.2')) ollamaModelSelect.value = 'llama3.2';
        else ollamaModelSelect.value = models[0];
    }

    providerSelect.addEventListener('change', function() {
        if (this.value === 'ollama') fetchOllamaModels();
    });

    transcriptionSelect.addEventListener('change', function() {
        fetch('/set_transcription_model', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ model: this.value })
        });
    });

    // ─── Spa sidebar ──────────────────────────────────────────────────────────

    function toggleSpaSidebar(selectedCharacter) {
        const sidebar = document.getElementById('spa-sidebar');
        if (!sidebar) return;
        if (selectedCharacter === 'customer_support') {
            sidebar.classList.remove('hidden');
            buildSpaCalendar();
            buildSpaTimePicker();
            setupServiceItemClicks();
        } else {
            sidebar.classList.add('hidden');
        }
    }

    function buildSpaTimePicker() {
        const container = document.getElementById('spa-time-picker');
        if (!container) return;
        container.innerHTML = '';

        // Spa operating hours: 10 AM – 7 PM, hourly slots
        const slots = [
            '10:00 AM', '11:00 AM', '12:00 PM',
            '1:00 PM',  '2:00 PM',  '3:00 PM',
            '4:00 PM',  '5:00 PM',  '6:00 PM', '7:00 PM'
        ];

        slots.forEach(slot => {
            const btn = document.createElement('button');
            btn.className = 'spa-time-slot';
            btn.textContent = slot;
            btn.dataset.time = slot;
            btn.addEventListener('click', () => {
                container.querySelectorAll('.spa-time-slot').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                const selectedTimeLabel = document.getElementById('spa-selected-time');
                if (selectedTimeLabel) selectedTimeLabel.textContent = `Selected: ${slot}`;
                bookingDetails.time = slot;

                if (isConversationActive && websocket && websocket.readyState === WebSocket.OPEN) {
                    stopVAD();
                    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                        mediaRecorder.onstop = () => { audioChunks = []; };
                        mediaRecorder.stop();
                    }
                    clearTimeout(checkInTimer);
                    const msg = `I'd prefer ${slot} for my appointment.`;
                    displayMessage(msg, 'user-message');
                    hideListeningIndicator();
                    setAgentState('thinking');
                    showThinkingIndicator();
                    websocket.send(JSON.stringify({ action: "text", text: msg }));
                }
            });
            container.appendChild(btn);
        });
    }

    function syncTimeSelection(timeStr) {
        // Highlight the matching time slot button
        document.querySelectorAll('.spa-time-slot').forEach(btn => {
            btn.classList.remove('selected');
            if (btn.dataset.time === timeStr) {
                btn.classList.add('selected');
                const label = document.getElementById('spa-selected-time');
                if (label) label.textContent = `Selected: ${timeStr}`;
                bookingDetails.time = timeStr;
            }
        });
    }

    function setupServiceItemClicks() {
        const doneWrap = document.getElementById('service-done-wrap');
        const doneBtn  = document.getElementById('service-done-btn');

        function refreshDoneVisibility() {
            if (doneWrap) doneWrap.style.display = bookingDetails.services.length > 0 ? '' : 'none';
        }

        document.querySelectorAll('.spa-service-item').forEach(item => {
            item.addEventListener('click', function() {
                const svc      = this.dataset.service;
                const price    = this.dataset.price || '';
                const duration = this.dataset.duration || '';

                const idx = bookingDetails.services.findIndex(s => s.name === svc);
                if (idx === -1) {
                    // Add to selection
                    this.classList.add('selected');
                    bookingDetails.services.push({ name: svc, price, duration: duration || null });
                } else {
                    // Deselect
                    this.classList.remove('selected');
                    bookingDetails.services.splice(idx, 1);
                }
                refreshDoneVisibility();
            });
        });

        if (doneBtn) {
            // Remove any previously attached listener to avoid duplicates
            const newBtn = doneBtn.cloneNode(true);
            doneBtn.parentNode.replaceChild(newBtn, doneBtn);

            newBtn.addEventListener('click', function() {
                if (bookingDetails.services.length === 0) return;
                if (!isConversationActive || !websocket || websocket.readyState !== WebSocket.OPEN) return;

                stopVAD();
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    mediaRecorder.onstop = () => { audioChunks = []; };
                    mediaRecorder.stop();
                }
                clearTimeout(checkInTimer);

                // Build a single message listing all selected services
                const lines = bookingDetails.services.map(s =>
                    s.duration ? `${s.name} (${s.duration}, ${s.price})` : `${s.name} (${s.price})`
                );
                const msg = lines.length === 1
                    ? `I'd like to book the ${lines[0]}.`
                    : `I'd like to book the following services: ${lines.join(', ')}.`;

                displayMessage(msg, 'user-message');
                hideListeningIndicator();
                setAgentState('thinking');
                showThinkingIndicator();
                websocket.send(JSON.stringify({ action: "text", text: msg }));

                // Hide the Done button after confirming
                if (doneWrap) doneWrap.style.display = 'none';
            });
        }
    }

    function buildSpaCalendar() {
        const cal   = document.getElementById('spa-calendar');
        const today = document.getElementById('spa-today');
        if (!cal || !today) return;
        const now   = new Date();
        const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        today.textContent = `Today: ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
        cal.innerHTML = '';
        const selectedLabel = document.getElementById('spa-selected-date');
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const header  = document.createElement('div');
        header.className = 'spa-calendar-header';
        header.textContent = `${months[now.getMonth()]} ${now.getFullYear()}`;
        cal.appendChild(header);
        const grid = document.createElement('div');
        grid.className = 'spa-calendar-grid';
        const firstDow = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
        for (let i = 0; i < (firstDow === 0 ? 6 : firstDow - 1); i++) {
            const empty = document.createElement('button');
            empty.className = 'spa-calendar-day empty';
            empty.disabled = true;
            grid.appendChild(empty);
        }
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        for (let d = 1; d <= lastDay.getDate(); d++) {
            const btn = document.createElement('button');
            btn.className = 'spa-calendar-day';
            btn.textContent = d;
            if (new Date(now.getFullYear(), now.getMonth(), d) < todayMidnight) {
                btn.disabled = true;
                btn.classList.add('past');
            }
            btn.addEventListener('click', () => {
                grid.querySelectorAll('.spa-calendar-day').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                const dateStr = `${d} ${months[now.getMonth()]} ${now.getFullYear()}`;
                if (selectedLabel) selectedLabel.textContent = `Selected: ${dateStr}`;

                // If a conversation is active, notify the AI about the selected date
                if (isConversationActive && websocket && websocket.readyState === WebSocket.OPEN) {
                    // Stop current recording/VAD so the AI can respond
                    stopVAD();
                    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                        mediaRecorder.onstop = () => { audioChunks = []; };
                        mediaRecorder.stop();
                    }
                    clearTimeout(checkInTimer);

                    // Send date as a text message — AI responds contextually
                    const textMsg = `I've selected ${dateStr} on the calendar.`;
                    displayMessage(textMsg, 'user-message');
                    hideListeningIndicator();
                    setAgentState('thinking');
                    showThinkingIndicator();
                    websocket.send(JSON.stringify({ action: "text", text: textMsg }));
                }
            });
            grid.appendChild(btn);
        }
        cal.appendChild(grid);
    }

    // ─── Theme ────────────────────────────────────────────────────────────────

    themeToggle.addEventListener('click', function() {
        body.classList.toggle('dark-mode');
        updateThemeIcon();
        localStorage.setItem('darkMode', body.classList.contains('dark-mode'));
    });

    function updateThemeIcon() {
        const dark = body.classList.contains('dark-mode');
        themeToggle.innerHTML = dark
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }

    const storedDark = localStorage.getItem('darkMode');
    if (storedDark !== null) body.classList.toggle('dark-mode', storedDark === 'true');
    updateThemeIcon();

    // ─── Download ─────────────────────────────────────────────────────────────

    downloadButton.addEventListener('click', async function() {
        const response = await fetch('/download_history');
        if (response.status === 200) {
            const text = await response.text();
            const blob = new Blob([text], { type: 'text/plain' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url; a.download = 'conversation_history.txt'; a.click();
            URL.revokeObjectURL(url);
        } else {
            alert("Failed to download conversation history.");
        }
    });

    // ─── Kokoro voices ────────────────────────────────────────────────────────

    fetch('/kokoro_voices')
        .then(r => r.json())
        .then(data => {
            const sel = document.getElementById('kokoro-voice-select');
            sel.innerHTML = '';
            if (data.voices?.length) {
                data.voices.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.id; opt.text = v.name;
                    sel.add(opt);
                });
            } else {
                const opt = document.createElement('option');
                opt.value = 'af_bella'; opt.text = 'Select Kokoro TTS to Load';
                sel.add(opt);
            }
        })
        .catch(() => {
            const sel = document.getElementById('kokoro-voice-select');
            sel.innerHTML = '';
            const opt = document.createElement('option');
            opt.value = 'af_bella'; opt.text = 'Select Kokoro TTS to Load';
            sel.add(opt);
        });

    // ─── Booking UI sync ──────────────────────────────────────────────────────

    function syncCalendarDate(dateStr) {
        // dateStr format: "20 March" — find the matching day button and click it
        const parts = dateStr.split(' ');
        const day = parseInt(parts[0], 10);
        if (isNaN(day)) return;
        const cal = document.getElementById('spa-calendar');
        if (!cal) return;
        cal.querySelectorAll('.spa-calendar-day').forEach(btn => {
            btn.classList.remove('selected');
            if (parseInt(btn.textContent, 10) === day && !btn.disabled) {
                btn.classList.add('selected');
                const selectedLabel = document.getElementById('spa-selected-date');
                if (selectedLabel) selectedLabel.textContent = `Selected: ${dateStr}`;
                bookingDetails.date = dateStr;
            }
        });
    }

    function syncServiceSelection(serviceName, price, duration) {
        // Add to multi-select if not already present
        const item = document.querySelector(`.spa-service-item[data-service="${CSS.escape(serviceName)}"]`);
        if (!item) return;
        const already = bookingDetails.services.some(s => s.name === serviceName);
        if (!already) {
            item.classList.add('selected');
            bookingDetails.services.push({ name: serviceName, price: price || item.dataset.price || '', duration: duration || item.dataset.duration || null });
        }
        const doneWrap = document.getElementById('service-done-wrap');
        if (doneWrap) doneWrap.style.display = bookingDetails.services.length > 0 ? '' : 'none';
    }

    function showBookingSummary() {
        const section = document.getElementById('booking-summary-section');
        const content = document.getElementById('booking-summary-content');
        if (!section || !content) return;

        const rows = [];
        if (bookingDetails.date) rows.push(['Date', bookingDetails.date]);
        if (bookingDetails.time) rows.push(['Time', bookingDetails.time]);
        bookingDetails.services.forEach((s, i) => {
            const label = bookingDetails.services.length > 1 ? `Service ${i + 1}` : 'Service';
            let detail = s.name;
            if (s.duration) detail += ` (${s.duration})`;
            if (s.price)    detail += ` — ${s.price}`;
            rows.push([label, detail]);
        });

        // Calculate total cost from service prices
        if (bookingDetails.services.length > 0) {
            let total = 0;
            let hasFrom = false;
            bookingDetails.services.forEach(s => {
                if (!s.price) return;
                const priceStr = s.price.toLowerCase();
                if (priceStr.includes('from')) hasFrom = true;
                // Extract first number from price string (e.g. "from 4,000 PKR" → 4000)
                const match = priceStr.replace(/,/g, '').match(/\d+/);
                if (match) total += parseInt(match[0], 10);
            });
            if (total > 0) {
                const formatted = total.toLocaleString('en-PK') + ' PKR';
                rows.push(['Total', hasFrom ? `from ${formatted}` : formatted]);
            }
        }

        if (rows.length === 0) return;

        content.innerHTML = rows.map(([label, value]) => {
            const extraClass = label === 'Total' ? ' total-row' : '';
            return `<div class="summary-row${extraClass}"><span class="summary-label">${label}</span><span class="summary-value">${value}</span></div>`;
        }).join('');

        section.style.display = '';
        section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    setAgentState('idle');
});
