# Mr. Grumble — voice-only rude English tutor

A tiny no-build web app: dark screen, one animated character face in the middle. Tap it, speak, and the tutor answers **only by voice**. Built for an adult Italian speaker learning English who *asked* for a rude, sarcastic, swearing tutor (no slurs, no attacks on groups, always gives the correction).

Files: `index.html`, `styles.css`, `app.js`. No dependencies. `index.html` loads them with a `?v=` cache-buster; bump it on every deploy.

## Run locally

The microphone generally doesn't work from `file://`, so serve the folder over HTTP:

```bash
cd /workspace/voice-tutor
python3 -m http.server 8765 --bind 127.0.0.1
# open http://localhost:8765 in Chrome
```

`localhost` counts as a secure context, so mic access works without HTTPS.

## Modes

### DEMO (default, no API key)
- `SpeechRecognition` (Chrome on Android/desktop; Safari on iPhone/iPad needs iOS 14.5+ with Siri/Dictation enabled: Settings → General → Keyboard → Dictation). Chrome sends the audio to Google's speech service, so it needs internet.
- Language pill at the bottom: `EN` (en-US, default) / `IT` (it-IT). `recognition.lang` is always set explicitly, `interimResults` on, `maxAlternatives = 3` (the most confident alternative wins), auto-stop after ~1–1.7 s of silence (8 s with no speech at all, 15 s max). `continuous` is false, except on iOS, where WebKit otherwise stops almost immediately. Our silence timer still ends the session there.
- The faint live caption under the face shows what was heard while you speak, plus the tutor's reply. Toggle it in settings or with `C`. Errors (`no-speech`, `audio-capture`, `not-allowed`, `service-not-allowed`, `network`) are always shown in Russian, and the face turns sad or annoyed.
- Replies are canned and picked by heuristics: nothing heard → Italian (or "ciao") → ~22 regex rules for typical Italian-speaker mistakes (*I have 30 years*, *people is*, *since three years*, *explain me*, *he don't*, *make a photo*, *depends of*, *informations*…) → greeting → "how are you" → short answer → question → otherwise grudging praise.
- When a rule matches, the tutor mocks you, says the corrected sentence, explains in Italian (Italian voice when one is installed) and tells you to repeat.
- Every reply has an emotion tag (angry / bored·annoyed / happy / sad / surprised / thinking) that drives the face.
- **Speech output (`speechSynthesis`) and its mobile workarounds:**
  - The first tap synchronously calls `speechSynthesis.cancel()` + `speak(" ")` before anything async. iOS and Android only allow speech that was first started from a user gesture. After that, replies spoken from async recognition callbacks work.
  - Voices are loaded properly: `getVoices()` is empty at first on mobile, so the app waits for `voiceschanged` or polls, with a timeout. An explicit voice is only set when an installed one matches; otherwise just `lang` (en-US / it-IT). A voice that fails to start is dropped and the chunk is retried without it.
  - `resume()` runs before every `speak()`. Utterances stay referenced (Chrome GC bug). Text is chunked into sentences. A watchdog resumes a paused queue, ends a chunk when `onend` never comes, and gives up (showing the text) if speech never starts.
  - Recognition and mic are stopped before speaking, with a ≥300 ms gap after recognition ends. On iOS, mic capture routes output to the earpiece or lowers the volume. On Safari 16.4+ `navigator.audioSession.type` is set to `playback` while speaking and to `auto` while listening.
  - If `onstart` doesn't fire within ~2 s, a one-time hint appears: "Не слышно? Проверь беззвучный режим и громкость".
  - Settings → **🔊 Проверить звук** speaks a test phrase inside the click and reports whether speech started, plus the voice count and chosen voice.
- On phones the extra `getUserMedia` level meter is off: a second mic stream next to SpeechRecognition degrades Android recognition and puts iOS into play-and-record mode. The face reacts to recognition events instead.
- LIVE mode (below) hears much better and has a natural voice. The UI mentions this.

### REAL (OpenAI Realtime, `gpt-realtime-2.1-mini`)
Click the gear (top right), paste an OpenAI API key and save. The badge changes to `LIVE`.
- The key is stored **only** in this browser's `localStorage`. The browser uses it to mint a short-lived client secret (`POST /v1/realtime/client_secrets`, which also carries the persona instructions, voice and tool), then opens a WebRTC connection (`POST /v1/realtime/calls` with the SDP offer). Audio goes over media tracks; events go over the `oai-events` data channel.
- If minting the secret fails for a reason other than auth or rate limits, the app tries the "unified interface" instead: a multipart `sdp` + `session` POST to `/v1/realtime/calls`.
- ⚠️ A key held in the browser is only OK for **personal, local use**. Don't host this publicly with a key in it. For anything shared, mint client secrets on a server.
- Tap the face to start a hands-free session (semantic VAD). The tutor greets you first. Tap again to end it.
- **How emotions work in real mode:** the model is told to call a `set_emotion({emotion})` function before each spoken reply. The app applies the emotion, returns the function output and, if the model hasn't spoken yet, sends `response.create` with `tool_choice: "none"`, so it speaks without looping on the tool. A text prefix like `[angry]` isn't usable because output is audio: the model would *say* the tag out loud. If a reply arrives with no tool call, the emotion is guessed from keywords in the streamed audio transcript.
- State mapping: `input_audio_buffer.speech_started` → listening, `speech_stopped` → thinking, `output_audio_buffer.started/stopped` → speaking/listening. The output audio level also drives speaking as a fallback. The mouth follows the real output level, and the eyes and brows react to your mic level.

## Face
SVG character with sclera, iris and pupils, upper and lower eyelids, brows, mouth, blush and an anger flush. All of it is driven by a parameter vector that eases smoothly toward the current emotion.
- Idle: neutral, random natural blinking (sometimes a double blink), wandering saccades. The eyes follow the cursor or touch.
- Listening: wide, attentive eyes looking straight at you, pulse rings, reacts to mic level.
- Thinking: eyes up and to one side, asymmetric brows.
- Speaking: the reply's emotion plus an animated mouth. After speaking, the face relaxes back to neutral.

## Hidden keys
- `Space` / `Enter`: same as tapping the face
- `E`: cycle emotions (preview)
- `S`: cycle states idle → listening → thinking → speaking (preview, demo mode only)
- `C`: toggle the faint live caption (also in settings)
- URL preview: `?emotion=angry&state=speaking`, and add `&snap` to skip easing and blinking (for screenshots)
