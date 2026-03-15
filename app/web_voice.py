"""
web_voice.py — WebSocket handler for browser-based voice chat.

Protocol (browser ↔ server):
  Browser → Server:
    {"action": "start",  "character": "sara", "model": "gpt-4o", "voice": "nova"}
    {"action": "audio",  "data": "<base64_webm_audio>"}
    {"action": "text",   "text": "user text message (e.g. date selected from calendar)"}
    {"action": "stop"}

  Server → Browser:
    {"action": "listening"}
    {"action": "thinking"}
    {"action": "transcript",      "text": "..."}
    {"action": "response_text",   "text": "..."}
    {"action": "audio_response",  "data": "<base64_audio>", "format": "mp3"}
    {"action": "done"}
    {"action": "error",           "message": "..."}
"""

import asyncio
import base64
from datetime import date
import json
import logging
import os
import tempfile

import aiohttp
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .app import (
    OPENAI_API_KEY,
    OPENAI_TTS_VOICE,
    chatgpt_streamed,
    open_file,
    sanitize_response,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Booking extraction helpers
# ---------------------------------------------------------------------------

_MONTHS_MAP = {
    'january': 'January', 'february': 'February', 'march': 'March',
    'april': 'April', 'may': 'May', 'june': 'June', 'july': 'July',
    'august': 'August', 'september': 'September', 'october': 'October',
    'november': 'November', 'december': 'December',
}

# Service keywords → (canonical name, price, duration)  Order matters — more specific first
_SERVICES_MAP = [
    (['gel manicure'],                      'Gel Manicure',           '4,200 PKR',        None),
    (['classic swedish', 'swedish massage', 'swedish'], 'Classic Swedish Massage', '7,500 PKR', '60 min'),
    (['deep tissue'],                       'Deep Tissue Massage',    '8,500 PKR',        '60 min'),
    (['aromatherapy'],                      'Aromatherapy Massage',   '11,500 PKR',       '90 min'),
    (['glow facial'],                       'Glow Facial',            '6,000 PKR',        '60 min'),
    (['hydrating facial', 'hydrating'],     'Hydrating Facial',       '7,500 PKR',        '75 min'),
    (['anti aging', 'anti-aging', 'anti ageing', 'anti-ageing'], 'Anti-Aging Facial', '9,500 PKR', '90 min'),
    (['keratin', 'smoothening', 'smoothing'], 'Keratin Treatment',   'from 18,000 PKR',  None),
    (['haircut', 'blow dry', 'blow-dry'],   'Haircut & Blow-dry',     'from 4,000 PKR',   None),
    (['root touch'],                        'Root Touch-up',          'from 5,500 PKR',   None),
    (['full color', 'full colour'],         'Full Color',             'from 8,500 PKR',   None),
    (['manicure'],                          'Classic Manicure',       '2,800 PKR',        None),
    (['pedicure'],                          'Classic Pedicure',       '3,200 PKR',        None),
    (['relax and glow', 'relax & glow', 'relax glow'], 'Relax & Glow Package', '13,000 PKR', None),
    (['full pamper', 'pamper day'],         'Full Pamper Day',        '19,500 PKR',       None),
]

_CONFIRMATION_PHRASES = [
    'reserved', 'our team will confirm', "you're all set", 'see you on',
    'looking forward to seeing you', "we'll be in touch", 'all booked',
]


def _extract_booking_info(text: str) -> dict:
    """Extract date and/or service mention from user text. Returns dict with found fields only."""
    import re
    text_l = text.lower()
    result = {}

    # --- Date extraction ---
    day_re = r'(\d{1,2})(?:st|nd|rd|th)?'
    for month_key, month_display in _MONTHS_MAP.items():
        # "20th March" / "20 of March"
        m = re.search(day_re + r'\s+(?:of\s+)?' + month_key, text_l)
        if m:
            day = int(m.group(1))
            if 1 <= day <= 31:
                result['date'] = f"{day} {month_display}"
                break
        # "March 20th"
        m = re.search(month_key + r'\s+' + day_re, text_l)
        if m:
            day = int(m.group(1))
            if 1 <= day <= 31:
                result['date'] = f"{day} {month_display}"
                break

    # --- Time extraction ---
    # Match "3 PM", "3:30 PM", "3:30pm", "3pm", "15:00", "15:30"
    time_m = re.search(r'\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b', text_l)
    if time_m:
        hour = int(time_m.group(1))
        mins = time_m.group(2) or '00'
        period = time_m.group(3).replace('.', '').upper()
        if 1 <= hour <= 12:
            result['time'] = f"{hour}:{mins} {period}"
    else:
        # 24-hour format "14:00", "15:30"
        time_m2 = re.search(r'\b(1[0-9]|2[0-3]):([0-5][0-9])\b', text_l)
        if time_m2:
            hour = int(time_m2.group(1))
            mins = time_m2.group(2)
            period = 'PM' if hour >= 12 else 'AM'
            disp = hour - 12 if hour > 12 else hour
            result['time'] = f"{disp}:{mins} {period}"

    # --- Service extraction ---
    for keywords, service_name, price, duration in _SERVICES_MAP:
        for kw in keywords:
            if kw in text_l:
                result['service'] = service_name
                result['service_price'] = price
                if duration:
                    result['service_duration'] = duration
                break
        if 'service' in result:
            break

    return result


def _is_booking_confirmed(ai_text: str) -> bool:
    """Return True if the AI response sounds like a booking confirmation/reservation."""
    t = ai_text.lower()
    return any(phrase in t for phrase in _CONFIRMATION_PHRASES)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CHARACTERS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "characters"
)


def _character_prompt_path(character: str) -> str:
    return os.path.join(CHARACTERS_DIR, character, f"{character}.txt")


async def _tts_to_mp3(text: str, voice: str) -> bytes:
    """Generate TTS via direct OpenAI REST call — bypasses SDK to avoid OPENAI_BASE_URL interference."""
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY is not set.")
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://api.openai.com/v1/audio/speech",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "tts-1",
                "input": text,
                "voice": voice,
                "response_format": "mp3",
            },
        ) as resp:
            if resp.status == 200:
                return await resp.read()
            error = await resp.text()
            raise RuntimeError(f"TTS API error {resp.status}: {error}")


async def _transcribe_webm(audio_bytes: bytes, filename: str = "audio.webm") -> str:
    """Send raw audio bytes to OpenAI transcription API and return the text."""
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY is not set.")

    api_url = "https://api.openai.com/v1/audio/transcriptions"

    async with aiohttp.ClientSession() as session:
        form_data = aiohttp.FormData()
        form_data.add_field(
            "file",
            audio_bytes,
            filename=filename,
            content_type="audio/webm",
        )
        form_data.add_field("model", "gpt-4o-mini-transcribe")

        headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}

        async with session.post(api_url, data=form_data, headers=headers) as resp:
            if resp.status == 200:
                result = await resp.json()
                return result.get("text", "").strip()
            else:
                error_body = await resp.text()
                raise RuntimeError(
                    f"Transcription API error {resp.status}: {error_body}"
                )


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@router.websocket("/ws_voice")
async def ws_voice_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("ws_voice: client connected")

    # Per-connection state
    character: str = "wizard"
    model: str = "gpt-4o-mini"
    voice: str = OPENAI_TTS_VOICE or "nova"
    history: list = []

    # Temp files created during this session (cleaned up on disconnect)
    temp_files: list = []

    async def send(payload: dict):
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception as exc:
            logger.warning("ws_voice: send failed: %s", exc)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await send({"action": "error", "message": "Invalid JSON"})
                continue

            action = message.get("action")

            # ------------------------------------------------------------------
            # "start" — initialise session
            # ------------------------------------------------------------------
            if action == "start":
                character = message.get("character", character)
                model = message.get("model", model)
                voice = message.get("voice", voice)
                history = []
                logger.info(
                    "ws_voice: start — character=%s model=%s voice=%s",
                    character, model, voice,
                )
                await send({"action": "listening"})

            # ------------------------------------------------------------------
            # "stop" — client explicitly ends the session
            # ------------------------------------------------------------------
            elif action == "stop":
                logger.info("ws_voice: stop requested by client")
                break

            # ------------------------------------------------------------------
            # "audio" — browser sends a base64-encoded audio blob
            # ------------------------------------------------------------------
            elif action == "audio":
                encoded = message.get("data", "")
                if not encoded:
                    await send({"action": "error", "message": "No audio data"})
                    await send({"action": "listening"})
                    continue

                # 1. Decode base64 → raw bytes → temp file
                try:
                    audio_bytes = base64.b64decode(encoded)
                except Exception as exc:
                    await send({"action": "error", "message": f"Base64 decode error: {exc}"})
                    await send({"action": "listening"})
                    continue

                tmp_audio = tempfile.NamedTemporaryFile(
                    suffix=".webm", delete=False
                )
                tmp_audio.write(audio_bytes)
                tmp_audio.close()
                temp_files.append(tmp_audio.name)

                # 2. Transcribe
                try:
                    transcript = await _transcribe_webm(
                        audio_bytes, os.path.basename(tmp_audio.name)
                    )
                except Exception as exc:
                    logger.error("ws_voice: transcription error: %s", exc)
                    await send({"action": "error", "message": f"Transcription error: {exc}"})
                    await send({"action": "listening"})
                    continue
                finally:
                    # Clean up audio temp file now — we no longer need it
                    try:
                        os.unlink(tmp_audio.name)
                        temp_files.remove(tmp_audio.name)
                    except Exception:
                        pass

                # 3. Empty transcript — ask user to speak again
                if not transcript:
                    await send({"action": "listening"})
                    continue

                await send({"action": "transcript", "text": transcript})
                # Extract booking info from user speech and sync UI
                booking_info = _extract_booking_info(transcript)
                if booking_info:
                    await send({"action": "booking_update", **booking_info})
                await send({"action": "thinking"})

                # 4. Load character system prompt
                prompt_path = _character_prompt_path(character)
                try:
                    system_msg = open_file(prompt_path)
                except Exception:
                    system_msg = f"You are {character.capitalize()}, a helpful AI assistant."
                    logger.warning(
                        "ws_voice: character prompt not found at %s — using fallback",
                        prompt_path,
                    )
                # Prepend current date so the LLM always knows what day it is
                today_str = date.today().strftime("%A, %d %B %Y")
                system_msg = f"Today's date is {today_str}.\n\n" + system_msg

                # 5. Generate AI response (sync → executor)
                try:
                    loop = asyncio.get_event_loop()
                    ai_response: str = await loop.run_in_executor(
                        None,
                        chatgpt_streamed,
                        transcript,
                        system_msg,
                        "",
                        history,
                    )
                except Exception as exc:
                    logger.error("ws_voice: chatgpt_streamed error: %s", exc)
                    await send({"action": "error", "message": f"LLM error: {exc}"})
                    await send({"action": "listening"})
                    continue

                # 6. Sanitize
                clean_response = sanitize_response(ai_response)

                # 7. Update conversation history
                history.append({"role": "user", "content": transcript})
                history.append({"role": "assistant", "content": clean_response})

                # 8. Generate TTS FIRST so text + audio arrive together (no visible gap)
                try:
                    mp3_bytes = await _tts_to_mp3(clean_response, voice)
                    audio_b64 = base64.b64encode(mp3_bytes).decode("utf-8")
                except Exception as exc:
                    logger.error("ws_voice: TTS error: %s", exc)
                    # Send text even if TTS fails
                    await send({"action": "response_text", "text": clean_response})
                    await send({"action": "error", "message": f"TTS error: {exc}"})
                    await send({"action": "done"})
                    continue

                # 9. Send text and audio back-to-back so they appear simultaneously
                await send({"action": "response_text", "text": clean_response})
                await send({"action": "audio_response", "data": audio_b64, "format": "mp3"})
                await send({"action": "done"})
                # Check if this response contains a booking confirmation
                if _is_booking_confirmed(clean_response):
                    await send({"action": "booking_confirmed"})

            # ------------------------------------------------------------------
            # "check_in" — browser detected prolonged silence; Sara prompts
            # ------------------------------------------------------------------
            elif action == "check_in":
                check_text = "Are you still there? Take your time — I'm listening."
                try:
                    mp3_bytes = await _tts_to_mp3(check_text, voice)
                    audio_b64 = base64.b64encode(mp3_bytes).decode("utf-8")
                    await send({"action": "response_text", "text": check_text})
                    await send({"action": "audio_response", "data": audio_b64, "format": "mp3"})
                    await send({"action": "done"})
                except Exception as exc:
                    logger.warning("ws_voice: check_in TTS error: %s", exc)
                    await send({"action": "listening"})

            # ------------------------------------------------------------------
            # "text" — browser sends a direct text message (e.g. calendar date)
            # Skips transcription; goes straight into LLM → TTS pipeline
            # ------------------------------------------------------------------
            elif action == "text":
                user_text = message.get("text", "").strip()
                if not user_text:
                    await send({"action": "listening"})
                    continue

                await send({"action": "transcript", "text": user_text})
                # Extract booking info from selected text and sync UI
                booking_info = _extract_booking_info(user_text)
                if booking_info:
                    await send({"action": "booking_update", **booking_info})
                await send({"action": "thinking"})

                prompt_path = _character_prompt_path(character)
                try:
                    system_msg = open_file(prompt_path)
                except Exception:
                    system_msg = f"You are {character.capitalize()}, a helpful AI assistant."
                today_str = date.today().strftime("%A, %d %B %Y")
                system_msg = f"Today's date is {today_str}.\n\n" + system_msg

                try:
                    loop = asyncio.get_event_loop()
                    ai_response: str = await loop.run_in_executor(
                        None, chatgpt_streamed, user_text, system_msg, "", history,
                    )
                except Exception as exc:
                    logger.error("ws_voice: text action LLM error: %s", exc)
                    await send({"action": "error", "message": f"LLM error: {exc}"})
                    await send({"action": "listening"})
                    continue

                clean_response = sanitize_response(ai_response)
                history.append({"role": "user", "content": user_text})
                history.append({"role": "assistant", "content": clean_response})

                try:
                    mp3_bytes = await _tts_to_mp3(clean_response, voice)
                    audio_b64 = base64.b64encode(mp3_bytes).decode("utf-8")
                except Exception as exc:
                    logger.error("ws_voice: text action TTS error: %s", exc)
                    await send({"action": "response_text", "text": clean_response})
                    await send({"action": "error", "message": f"TTS error: {exc}"})
                    await send({"action": "done"})
                    continue

                await send({"action": "response_text", "text": clean_response})
                await send({"action": "audio_response", "data": audio_b64, "format": "mp3"})
                await send({"action": "done"})
                # Check if this response contains a booking confirmation
                if _is_booking_confirmed(clean_response):
                    await send({"action": "booking_confirmed"})

            else:
                await send({"action": "error", "message": f"Unknown action: {action}"})

    except WebSocketDisconnect:
        logger.info("ws_voice: client disconnected")
    except Exception as exc:
        logger.error("ws_voice: unhandled error: %s", exc, exc_info=True)
        try:
            await send({"action": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        # Clean up any remaining temp files
        for path in temp_files:
            try:
                if os.path.exists(path):
                    os.unlink(path)
            except Exception:
                pass
        logger.info("ws_voice: session cleaned up")
