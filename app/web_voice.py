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
                await send({"action": "thinking"})

                prompt_path = _character_prompt_path(character)
                try:
                    system_msg = open_file(prompt_path)
                except Exception:
                    system_msg = f"You are {character.capitalize()}, a helpful AI assistant."

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
