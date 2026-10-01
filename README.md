# Mr. Grumble — voice-only rude English tutor

A tiny no-build web app: dark screen, one animated character face in the middle. Tap it, speak, and the tutor answers **only by voice**. Built for an adult Italian speaker learning English who *asked* for a rude, sarcastic, swearing tutor (no slurs, no attacks on groups, always gives the correction).

Files: `index.html`, `styles.css`, `app.js`. No dependencies.

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
- `SpeechRecognition` (works best in Chrome/Edge; Chrome sends the audio to Google's speech service, so it needs internet).
- Language pill at the bottom: `AUTO` (en-US recognizer + Italian-word detector), `EN` (en-US), `IT` (it-IT).
- Replies are canned and picked by heuristics: nothing heard → Italian (or "ciao") → ~22 regex rules for typical Italian-speaker mistakes (*I have 30 years*, *people is*, *since three years*, *explain me*, *he don't*, *make a photo*, *depends of*, *informations*…) → greeting → "how are you" → short answer → question → otherwise grudging praise.
- When a rule matches, the tutor mocks you, says the corrected sentence, explains in Italian (Italian voice when one is installed) and tells you to repeat.
- Every reply has an emotion tag (angry / bored·annoyed / happy / sad / surprised / thinking) that drives the face.
- Speech is played with `speechSynthesis`, preferring an en-GB voice.

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
- `C`: toggle the faint debug caption (also in settings)
- URL preview: `?emotion=angry&state=speaking`, and add `&snap` to skip easing and blinking (for screenshots)
