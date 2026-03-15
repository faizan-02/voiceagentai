document.addEventListener("DOMContentLoaded", function() {
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const websocket = new WebSocket(`${wsProto}://${window.location.host}/ws`);
    const themeToggle = document.getElementById('theme-toggle');
    const downloadButton = document.getElementById('download-button');
    const body = document.body;
    const voiceAnimation = document.getElementById('voice-animation');
    const startButton = document.getElementById('start-conversation-btn');
    const stopButton = document.getElementById('stop-conversation-btn');
    const clearButton = document.getElementById('clear-conversation-btn');
    const messages = document.getElementById('messages');
    const micIcon = document.getElementById('mic-icon');
    const characterSelect = document.getElementById('character-select');
    const providerSelect = document.getElementById('provider-select');
    const ttsSelect = document.getElementById('tts-select');
    const openaiVoiceSelect = document.getElementById('openai-voice-select');
    const statusBar = document.getElementById('status-bar');

    // Set initial TTS provider from server
    const initialTTS = ttsSelect.dataset.initial;
    if (initialTTS && initialTTS !== 'None' && initialTTS !== '') {
        ttsSelect.value = initialTTS;
    }

    const elevenLabsVoiceSelect = document.getElementById('elevenlabs-voice-select');
    const kokoroVoiceSelect = document.getElementById('kokoro-voice-select');
    const openaiModelSelect = document.getElementById('openai-model-select');
    const ollamaModelSelect = document.getElementById('ollama-model-select');
    const xaiModelSelect = document.getElementById('xai-model-select');
    const voiceSpeedSelect = document.getElementById('voice-speed-select');
    const transcriptionSelect = document.getElementById('transcription-select');

    let aiMessageQueue = [];
    let isAISpeaking = false;

    // Agent state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'goodbye'
    let agentState = 'idle';

    // Fetch and populate characters as soon as page loads
    fetchCharacters();

    // Fetch Ollama models if that's the current provider
    if (providerSelect.value === 'ollama') {
        fetchOllamaModels();
    }

    // ─── State Management ───────────────────────────────────────────────────────

    function setAgentState(state) {
        agentState = state;
        updateStatusBar();
        updateButtonStates();
        updateMicIcon();
    }

    function updateStatusBar() {
        if (!statusBar) return;
        statusBar.className = 'status-bar status-' + agentState;
        const icons = {
            idle:      '○',
            listening: '◉',
            thinking:  '◌',
            speaking:  '▶',
            goodbye:   '✓'
        };
        const labels = {
            idle:      'Ready — press Start to begin',
            listening: 'Listening…',
            thinking:  'Thinking…',
            speaking:  'Speaking…',
            goodbye:   'Conversation ended'
        };
        statusBar.innerHTML = `<span class="status-dot">${icons[agentState] || '○'}</span>
                               <span class="status-label">${labels[agentState] || ''}</span>`;
    }

    function updateButtonStates() {
        const active = (agentState !== 'idle' && agentState !== 'goodbye');
        startButton.disabled = active || !websocket || websocket.readyState !== WebSocket.OPEN;
        stopButton.disabled  = !active;

        startButton.classList.toggle('btn-active', !active);
        stopButton.classList.toggle('btn-danger-active', active);
    }

    function updateMicIcon() {
        micIcon.classList.remove('mic-on', 'mic-off', 'mic-waiting', 'pulse-animation');
        if (agentState === 'listening') {
            micIcon.classList.add('mic-on', 'pulse-animation');
        } else if (agentState === 'thinking') {
            micIcon.classList.add('mic-waiting');
        } else if (agentState === 'speaking') {
            micIcon.classList.add('mic-on');
        } else {
            micIcon.classList.add('mic-off');
        }
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    websocket.onopen = function() {
        console.log("WebSocket open.");
        setAgentState('idle');
    };

    websocket.onclose = function() {
        console.log("WebSocket closed.");
        setAgentState('idle');
    };

    websocket.onerror = function(event) {
        console.error("WebSocket error:", event);
        setAgentState('idle');
    };

    websocket.onmessage = function(event) {
        let data;

        if (typeof event.data === 'string' && !event.data.startsWith('{') && !event.data.startsWith('[')) {
            displayMessage(event.data);
            return;
        }

        try {
            data = JSON.parse(event.data);
        } catch (e) {
            if (event.data && typeof event.data === 'string') {
                displayMessage(event.data);
                return;
            }
            data = { message: event.data };
        }

        if (data.action === "ai_start_speaking") {
            isAISpeaking = true;
            setAgentState('speaking');
            showVoiceAnimation();
            setTimeout(processQueuedMessages, 100);

        } else if (data.action === "ai_stop_speaking") {
            isAISpeaking = false;
            hideVoiceAnimation();
            processQueuedMessages();
            // Go back to listening if conversation is still active
            if (agentState === 'speaking') {
                setAgentState('listening');
            }

        } else if (data.action === "thinking") {
            setAgentState('thinking');
            showThinkingIndicator();

        } else if (data.action === "thinking_done") {
            hideThinkingIndicator();
            // State will be updated to 'speaking' when ai_start_speaking arrives

        } else if (data.action === "conversation_ended") {
            isAISpeaking = false;
            hideVoiceAnimation();
            hideThinkingIndicator();
            hideListeningIndicator();
            setAgentState('goodbye');
            displayMessage(data.message || "Goodbye! Chat again soon.", 'goodbye-message');
            // Reset to idle after a short delay
            setTimeout(() => setAgentState('idle'), 3000);

        } else if (data.action === "error") {
            console.error("Server error:", data.message);
            displayMessage(data.message, 'error-message');

        } else if (data.action === "waiting_for_speech") {
            setAgentState('listening');
            showListeningIndicator();

        } else if (data.message) {
            if (data.message.startsWith('You:')) {
                setAgentState('thinking');
                displayMessage(data.message);
                hideListeningIndicator();
            } else {
                // Plain text from AI (displayed before or after speech)
                aiMessageQueue.push(data.message);
                if (!isAISpeaking) {
                    processQueuedMessages();
                }
            }

        } else if (data.action === "recording_started") {
            setAgentState('listening');
            showListeningIndicator();

        } else if (data.action === "recording_stopped") {
            hideListeningIndicator();
            if (agentState === 'listening') {
                setAgentState('thinking');
            }
        }
    };

    function processQueuedMessages() {
        while (aiMessageQueue.length > 0 && !isAISpeaking) {
            displayMessage(aiMessageQueue.shift());
        }
    }

    // ─── Indicators ───────────────────────────────────────────────────────────

    function showListeningIndicator() {
        hideListeningIndicator();
        const el = document.createElement('div');
        el.className = 'listening-indicator';
        el.id = 'listening-indicator';
        el.innerHTML = 'Listening <div class="listening-dots"><div class="dot"></div><div class="dot" style="animation-delay:0.2s"></div><div class="dot" style="animation-delay:0.4s"></div></div>';
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
        el.innerHTML = 'Thinking <div class="thinking-dots"><div class="dot"></div><div class="dot" style="animation-delay:0.2s"></div><div class="dot" style="animation-delay:0.4s"></div></div>';
        messages.appendChild(el);
        scrollToBottom();
    }

    function hideThinkingIndicator() {
        const el = document.getElementById('thinking-indicator');
        if (el) el.remove();
    }

    // ─── Voice Animation ──────────────────────────────────────────────────────

    function showVoiceAnimation() {
        voiceAnimation.classList.remove('hidden');
        scrollToBottom();
    }

    function hideVoiceAnimation() {
        voiceAnimation.classList.add('hidden');
        setTimeout(() => {
            scrollToBottom();
            processQueuedMessages();
        }, 100);
    }

    function scrollToBottom() {
        const conversation = document.getElementById('conversation');
        conversation.scrollTop = conversation.scrollHeight;
    }

    // ─── Message Display ─────────────────────────────────────────────────────

    function displayMessage(message, className = '') {
        let formattedMessage = message;

        // Strip out <think>...</think> blocks
        formattedMessage = formattedMessage.replace(/<think>[\s\S]*?<\/think>/g, '');

        const messageElement = document.createElement('div');
        if (className) {
            messageElement.className = className;
        } else if (formattedMessage.startsWith('You:')) {
            messageElement.className = 'user-message';
            formattedMessage = formattedMessage.replace('You:', '').trim();
        } else {
            messageElement.className = 'ai-message';
        }

        if (formattedMessage.includes('```')) {
            let segments = formattedMessage.split(/(```(?:.*?)```)/gs);
            segments.forEach(segment => {
                if (segment.startsWith('```') && segment.endsWith('```')) {
                    const codeContent = segment.slice(3, -3).trim();
                    const pre = document.createElement('pre');
                    const code = document.createElement('code');
                    code.textContent = codeContent;
                    pre.appendChild(code);
                    messageElement.appendChild(pre);
                } else if (segment.trim()) {
                    segment.split('\n').forEach((line, index) => {
                        if (index > 0) messageElement.appendChild(document.createElement('br'));
                        messageElement.appendChild(document.createTextNode(line));
                    });
                }
            });
        } else if (formattedMessage.includes('\n')) {
            formattedMessage.split('\n').forEach((line, index) => {
                if (index > 0) messageElement.appendChild(document.createElement('br'));
                messageElement.appendChild(document.createTextNode(line));
            });
        } else {
            messageElement.textContent = formattedMessage;
        }

        messages.appendChild(messageElement);
        setTimeout(scrollToBottom, 10);
    }

    // ─── Button Actions ───────────────────────────────────────────────────────

    startButton.addEventListener('click', function() {
        const selectedCharacter = document.getElementById('character-select').value;
        websocket.send(JSON.stringify({ action: "start", character: selectedCharacter }));
        setAgentState('listening');
    });

    stopButton.addEventListener('click', function() {
        websocket.send(JSON.stringify({ action: "stop" }));
        stopButton.disabled = true;
        // Fallback reset in case server doesn't send conversation_ended within 10s
        setTimeout(() => {
            if (agentState !== 'idle' && agentState !== 'goodbye') setAgentState('idle');
        }, 10000);
    });

    clearButton.addEventListener('click', async function() {
        messages.innerHTML = '';
        try {
            await fetch('/clear_history', { method: 'POST' });
            displayMessage("Conversation history cleared.", "system-message");
        } catch (error) {
            displayMessage("Error clearing conversation history", "error-message");
        }
    });

    // ─── Character & Settings ─────────────────────────────────────────────────

    function fetchCharacters() {
        fetch('/characters')
            .then(r => r.json())
            .then(data => populateCharacterSelect(data.characters))
            .catch(err => console.error('Error fetching characters:', err));
    }

    function fetchOllamaModels() {
        fetch('/ollama_models')
            .then(r => r.json())
            .then(data => {
                if (data.models && data.models.length > 0) populateOllamaModelSelect(data.models);
            })
            .catch(err => console.error('Error fetching Ollama models:', err));
    }

    function populateOllamaModelSelect(models) {
        const currentValue = ollamaModelSelect.value;
        ollamaModelSelect.innerHTML = '';
        models.sort((a, b) => a.localeCompare(b)).forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            ollamaModelSelect.appendChild(opt);
        });
        if (models.includes(currentValue)) ollamaModelSelect.value = currentValue;
        else if (models.includes('llama3.2')) ollamaModelSelect.value = 'llama3.2';
        else if (models.length > 0) ollamaModelSelect.value = models[0];
    }

    function populateCharacterSelect(characters) {
        characterSelect.innerHTML = '';
        characters.sort((a, b) => a.localeCompare(b)).forEach(character => {
            const opt = document.createElement('option');
            opt.value = character;
            opt.textContent = character.replace(/_/g, ' ');
            characterSelect.appendChild(opt);
        });
        const defaultCharacter = document.querySelector('meta[name="default-character"]')?.getAttribute('content');
        if (defaultCharacter) characterSelect.value = defaultCharacter;
        toggleSpaSidebar(characterSelect.value);
    }

    characterSelect.addEventListener('change', function() {
        const selectedCharacter = this.value;
        toggleSpaSidebar(selectedCharacter);
        messages.innerHTML = '';

        fetch('/set_character', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ character: selectedCharacter })
        })
        .then(r => r.json())
        .then(data => {
            if (selectedCharacter.startsWith('story_') || selectedCharacter.startsWith('game_')) {
                fetch('/get_character_history')
                    .then(r => r.json())
                    .then(historyData => {
                        if (historyData.status === 'success' && historyData.history) {
                            const lines = historyData.history.split('\n');
                            let speaker = null, msg = '';
                            lines.forEach(line => {
                                if (line.startsWith('User:')) {
                                    if (speaker && msg) displayMessage(speaker === 'User' ? `You: ${msg}` : msg);
                                    speaker = 'User'; msg = line.substring(5).trim();
                                } else if (line.startsWith('Assistant:')) {
                                    if (speaker && msg) displayMessage(speaker === 'User' ? `You: ${msg}` : msg);
                                    speaker = 'Assistant'; msg = line.substring(10).trim();
                                } else if (line.trim() && speaker) {
                                    msg += '\n' + line;
                                }
                            });
                            if (speaker && msg) displayMessage(speaker === 'User' ? `You: ${msg}` : msg);
                            displayMessage(`History loaded for ${selectedCharacter.replace(/_/g, ' ')}. Press Start to continue.`, 'system-message');
                            scrollToBottom();
                        }
                    });
            }
        })
        .catch(err => console.error('Error setting character:', err));
    });

    // ─── Settings Listeners ───────────────────────────────────────────────────

    function setProvider() {
        const provider = providerSelect.value;
        websocket.send(JSON.stringify({ action: "set_provider", provider }));
        if (provider === 'ollama') fetchOllamaModels();
    }

    providerSelect.addEventListener('change', setProvider);
    ttsSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_tts", tts: ttsSelect.value })));
    openaiVoiceSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_openai_voice", voice: openaiVoiceSelect.value })));
    openaiModelSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_openai_model", model: openaiModelSelect.value })));
    ollamaModelSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_ollama_model", model: ollamaModelSelect.value })));
    xaiModelSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_xai_model", model: xaiModelSelect.value })));
    voiceSpeedSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_voice_speed", speed: voiceSpeedSelect.value })));
    elevenLabsVoiceSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_elevenlabs_voice", voice: elevenLabsVoiceSelect.value })));
    kokoroVoiceSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_kokoro_voice", voice: kokoroVoiceSelect.value })));

    const anthropicModelSelect = document.getElementById('anthropic-model-select');
    if (anthropicModelSelect) {
        anthropicModelSelect.addEventListener('change', () => websocket.send(JSON.stringify({ action: "set_anthropic_model", model: anthropicModelSelect.value })));
    }

    transcriptionSelect.addEventListener('change', function() {
        fetch('/set_transcription_model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.value })
        });
    });

    // ─── Spa Sidebar ──────────────────────────────────────────────────────────

    function toggleSpaSidebar(selectedCharacter) {
        const spaSidebar = document.getElementById('spa-sidebar');
        if (!spaSidebar) return;
        if (selectedCharacter === 'customer_support') {
            spaSidebar.classList.remove('hidden');
            buildSpaCalendar();
        } else {
            spaSidebar.classList.add('hidden');
        }
    }

    function buildSpaCalendar() {
        const calendarContainer = document.getElementById('spa-calendar');
        const todayLabel = document.getElementById('spa-today');
        if (!calendarContainer || !todayLabel) return;
        const now = new Date();
        const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        todayLabel.textContent = `Today: ${now.getDate()} ${monthNames[now.getMonth()]} ${now.getFullYear()}`;
        calendarContainer.innerHTML = '';
        const selectedDateLabel = document.getElementById('spa-selected-date');
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const header = document.createElement('div');
        header.className = 'spa-calendar-header';
        header.textContent = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;
        calendarContainer.appendChild(header);
        const grid = document.createElement('div');
        grid.className = 'spa-calendar-grid';
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
        for (let i = 0; i < (firstDay === 0 ? 6 : firstDay - 1); i++) {
            const empty = document.createElement('button');
            empty.className = 'spa-calendar-day empty';
            empty.disabled = true;
            grid.appendChild(empty);
        }
        for (let d = 1; d <= end.getDate(); d++) {
            const dateObj = new Date(now.getFullYear(), now.getMonth(), d);
            const btn = document.createElement('button');
            btn.className = 'spa-calendar-day';
            btn.textContent = d.toString();
            if (dateObj < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
                btn.disabled = true;
                btn.classList.add('past');
            }
            btn.addEventListener('click', () => {
                grid.querySelectorAll('.spa-calendar-day').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                if (selectedDateLabel) selectedDateLabel.textContent = `Selected: ${d} ${monthNames[now.getMonth()]} ${now.getFullYear()}`;
            });
            grid.appendChild(btn);
        }
        calendarContainer.appendChild(grid);
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
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
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
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'conversation_history.txt';
            a.click();
            URL.revokeObjectURL(url);
        } else {
            alert("Failed to download conversation history.");
        }
    });

    // ─── Kokoro Voices ────────────────────────────────────────────────────────

    fetch('/kokoro_voices')
        .then(r => r.json())
        .then(data => {
            const sel = document.getElementById('kokoro-voice-select');
            sel.innerHTML = '';
            if (data.voices && data.voices.length > 0) {
                data.voices.forEach(voice => {
                    const opt = document.createElement('option');
                    opt.value = voice.id;
                    opt.text = voice.name;
                    sel.add(opt);
                });
            } else {
                const opt = document.createElement('option');
                opt.value = 'af_bella';
                opt.text = 'Select Kokoro TTS to Load';
                sel.add(opt);
            }
        })
        .catch(() => {
            const sel = document.getElementById('kokoro-voice-select');
            sel.innerHTML = '';
            const opt = document.createElement('option');
            opt.value = 'af_bella';
            opt.text = 'Select Kokoro TTS to Load';
            sel.add(opt);
        });

    // ─── Init ─────────────────────────────────────────────────────────────────

    setAgentState('idle');
});
