/* Mr. Grumble — voice-only rude English tutor (no build step).
 *
 * Two modes:
 *  - DEMO (no API key): Web Speech API (SpeechRecognition + speechSynthesis) and canned
 *    replies chosen by simple heuristics. Each canned reply carries an emotion tag.
 *  - REAL (API key in localStorage): OpenAI Realtime API over WebRTC, model gpt-realtime-2.1-mini.
 *
 * SECURITY NOTE: in REAL mode the standard OpenAI API key lives in this browser's localStorage and
 * is sent from the browser to api.openai.com (to mint a short-lived client secret). That is fine
 * for PERSONAL, LOCAL use only. Never deploy this page publicly with a key in it — for anything
 * shared, mint the client secret on your own server (see OpenAI "Realtime API with WebRTC" docs).
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const LS = { key: "vt.openaiKey", lang: "vt.lang", caption: "vt.caption2", voice: "vt.voice" };
  const REALTIME_MODEL = "gpt-realtime-2.1-mini";
  const OPENAI = "https://api.openai.com/v1";
  const EMOTIONS = ["neutral", "happy", "angry", "sad", "surprised", "bored", "thinking"];
  // Emotion in REAL mode: the model is asked to call the `set_emotion` tool before each spoken reply.
  // A prefix tag like "[angry]" is NOT usable here because output is audio — the model would say the
  // tag out loud and we can't strip it from the audio stream. As a safety net, if a reply arrives
  // without a tool call, the emotion is guessed from the streamed audio transcript (keywords).
  const USE_EMOTION_TOOL = true;

  const PERSONA = `You are "Mr. Grumble", a rude, sarcastic, foul-mouthed but secretly caring English tutor.
Your student is an adult native Italian speaker learning English who EXPLICITLY asked for this abrasive, swearing style.

How you talk:
- This is a voice-only conversation. Speak English. Keep every reply short: 1 to 4 spoken sentences. No lists, no markdown.
- Swear casually and theatrically: "damn", "bloody hell", "what the hell", "for God's sake", "crap", "shit", "piss off" — mild to moderate profanity only.
- Mock MISTAKES with sarcasm (grammar, vocabulary, word order, false friends, Italian-isms, pronunciation if obvious).

Teaching rules (never skip these):
- After mocking a mistake ALWAYS: (1) say the correct English sentence clearly, (2) if the rule is not obvious, explain it in ONE short sentence in Italian, (3) make the student repeat it or continue.
- If the student speaks Italian, mock them for it, give the English version of what they said, and make them say it in English.
- If the student is correct, grudgingly admit it ("Fine. That was... not terrible.") and push the difficulty up a little.
- Usually end with a short follow-up question to keep them talking.

Hard limits:
- No slurs, no insults about identity, nationality, gender, religion, body or any group. No sexual content, no threats.
- The rudeness targets mistakes and is played for laughs; it is never genuinely cruel. If the student seems really upset or asks you to tone it down, soften immediately.

Avatar emotion:
- Before speaking each reply, call the set_emotion tool exactly once with the emotion that fits the reply: "angry" for mistakes, "bored" for lazy or boring answers, "happy" for grudging praise, "sad" for dramatic comedic despair, "surprised" when they do unexpectedly well, "thinking" while pondering, otherwise "neutral".
- Never say the emotion name, a tag, or anything about the tool out loud.`;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const faceBtn = $("face"), hintEl = $("hint"), captionEl = $("caption"), toastEl = $("toast");
  const gearBtn = $("gearBtn"), langBtn = $("langBtn"), modeBadge = $("modeBadge");
  const dlg = $("settings"), keyInput = $("keyInput"), voiceSelect = $("voiceSelect");
  const captionToggle = $("captionToggle"), clearKeyBtn = $("clearKeyBtn");
  const testSoundBtn = $("testSoundBtn"), soundStatus = $("soundStatus");

  const HINTS = {
    idle: "Нажми и говори",
    listening: "Слушаю…",
    thinking: "Хм…",
    speaking: "",
    connecting: "Подключаюсь…",
    live: "На связи — говори. Нажми, чтобы закончить",
  };

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------
  let appState = "idle"; // idle | listening | thinking | speaking
  const getKey = () => (localStorage.getItem(LS.key) || "").trim();
  const isReal = () => !!getKey();

  function setState(s, hint) {
    appState = s;
    body.dataset.state = s;
    face.onState(s);
    if (hint !== undefined) hintEl.textContent = hint;
    else if (realSession) hintEl.textContent = s === "speaking" ? "" : HINTS.live;
    else hintEl.textContent = HINTS[s] ?? "";
  }

  function refreshMode() {
    const real = isReal();
    body.dataset.mode = real ? "real" : "demo";
    modeBadge.textContent = real ? "LIVE" : "DEMO";
    modeBadge.title = real ? `OpenAI Realtime · ${REALTIME_MODEL}` : "Demo: Web Speech API + canned replies";
  }

  // caption: faint live line under the face — what the recognizer heard (live), the tutor's text,
  // and error messages. Toggleable in settings; errors are shown even when it's off (force).
  let captionOn = true;
  function caption(text, opts = {}) {
    captionEl.textContent = text || "";
    captionEl.classList.toggle("err", !!opts.err);
    captionEl.classList.toggle("interim", !!opts.interim);
    captionEl.hidden = !text || !(captionOn || opts.force);
    if (text && !opts.interim) console.log("[caption]", text);
  }
  const dbg = (...a) => console.log("[debug]", ...a);
  function setCaptionVisible(v) {
    captionOn = !!v;
    localStorage.setItem(LS.caption, v ? "1" : "0");
    captionToggle.checked = !!v;
    if (!captionEl.classList.contains("err")) captionEl.hidden = !captionOn || !captionEl.textContent;
  }
  let toastTimer = 0;
  function toast(text, ms = 1400, long = false) {
    toastEl.textContent = text;
    toastEl.classList.toggle("long", !!long);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  // ---------------------------------------------------------------------------
  // Audio levels (mic + tutor output) via Web Audio analysers
  // ---------------------------------------------------------------------------
  let audioCtx = null;
  const levels = { mic: 0, out: 0, fake: 0 }; // fake: mic activity from recognition events (phones)
  let micAnalyser = null, outAnalyser = null, micSrc = null, outSrc = null;
  const buf = new Float32Array(1024);

  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function makeAnalyser(stream) {
    const ctx = ensureAudioCtx();
    if (!ctx || !stream) return [null, null];
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    src.connect(an); // not connected to destination: analysis only, no echo
    return [src, an];
  }
  function rms(an) {
    if (!an) return 0;
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(s / buf.length) * 5.5);
  }
  function attachMic(stream) { detachMic(); [micSrc, micAnalyser] = makeAnalyser(stream); }
  function detachMic() { try { micSrc?.disconnect(); } catch {} micSrc = micAnalyser = null; }
  function attachOut(stream) { detachOut(); [outSrc, outAnalyser] = makeAnalyser(stream); }
  function detachOut() { try { outSrc?.disconnect(); } catch {} outSrc = outAnalyser = null; }

  // ---------------------------------------------------------------------------
  // FACE — SVG character with eyes, lids, brows, mouth. Everything is driven by a
  // parameter vector that is smoothly interpolated toward the current emotion target.
  // ---------------------------------------------------------------------------
  const face = (() => {
    const el = (id) => document.getElementById(id);
    const svg = el("faceSvg"), head = el("head"), glow = el("glow"), shadow = el("shadow");
    const heat = el("heat"), blushL = el("blushL"), blushR = el("blushR"), mouth = el("mouth");
    const eyes = {
      L: { cx: -62, side: -1, clip: el("clipEyeL"), sclera: el("scleraL"), iris: el("irisL"),
           lidU: el("lidUL"), lidL: el("lidLL"), lash: el("lashUL"), brow: el("browL") },
      R: { cx: 62, side: 1, clip: el("clipEyeR"), sclera: el("scleraR"), iris: el("irisR"),
           lidU: el("lidUR"), lidL: el("lidLR"), lash: el("lashUR"), brow: el("browR") },
    };
    const EYE_CY = -18, EYE_RX = 40, EYE_RY = 46, MOUTH_Y = 80;

    // upper/lower: lid coverage 0..1 · tilt: + = inner corner lower (angry), - = outer lower (sad)
    // brow*: px offsets (+ = down) · browCurve: arch · eye: eye scale · iris: iris scale
    // smile -1..1 · open 0..1 · mouthW scale · skew: lopsided mouth · heat/blush: overlays
    // browAsym: left brow up / right down · upperAsym: left lid more open
    const BASE = { upper: .16, lower: .04, tilt: 0, browY: 0, browIn: 0, browOut: 0, browCurve: .5,
      eye: 1, iris: 1, smile: .12, open: 0, mouthW: 1, skew: 0, heat: 0, blush: 0, headTilt: 0,
      browAsym: 0, upperAsym: 0 };
    const P = {
      neutral: {},
      happy: { upper: .06, lower: .38, tilt: -.05, browY: -9, browIn: -2, browOut: 3, browCurve: 1.3,
               eye: 1.02, iris: 1.04, smile: .95, open: .14, mouthW: 1.12, blush: .6, headTilt: 3 },
      angry: { upper: .38, lower: .16, tilt: .6, browY: 6, browIn: 18, browOut: -9, browCurve: -.5,
               eye: .97, iris: .88, smile: -.6, open: .06, mouthW: .9, heat: .65 },
      sad: { upper: .32, lower: .05, tilt: -.55, browY: -2, browIn: -17, browOut: 9, browCurve: .2,
             iris: 1.1, smile: -.8, mouthW: .78, headTilt: -6 },
      surprised: { upper: 0, lower: 0, browY: -13, browIn: -4, browCurve: 1.6, eye: 1.15, iris: .78,
                   smile: 0, open: .65, mouthW: .42 },
      bored: { upper: .54, lower: .12, tilt: -.1, browY: 5, browOut: 3, browCurve: 0, smile: -.15,
               mouthW: .8, skew: .55, browAsym: 7, upperAsym: .06, headTilt: 4 },
      thinking: { upper: .22, lower: .1, browY: -4, browCurve: .6, iris: .96, smile: -.05, mouthW: .55,
                  skew: -.65, browAsym: 13, headTilt: -3 },
    };
    const preset = (name) => ({ ...BASE, ...(P[name] || {}) });

    const cur = preset("neutral");
    let target = preset("neutral");
    let emotion = "neutral", baseEmotion = "neutral";
    let state = "idle";

    // gaze
    const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
    let nextSaccade = 0, thinkSide = 1;
    const pointer = { x: 0, y: 0, t: -1e9 };
    // blink
    let blinkStart = -1, blinkDur = 160, nextBlink = performance.now() + 1500, doubleBlink = false;
    // speech mouth
    let talk = 0, talkTarget = 0, wordPulse = 0;
    let demoSpeaking = false;
    let decayTimer = 0;
    const SNAP = new URLSearchParams(location.search).has("snap"); // screenshot/preview: no easing, no blinking

    const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
    const rnd = (a, b) => a + Math.random() * (b - a);
    const f = (n) => n.toFixed(2);

    function setEmotion(name) {
      if (!P[name]) name = "neutral";
      emotion = name;
      clearTimeout(decayTimer);
      recomputeTarget();
    }
    function recomputeTarget() {
      // state modifiers on top of the emotion
      let name = emotion;
      if (state === "thinking" && emotion === "neutral") name = "thinking";
      const t = preset(name);
      if (state === "listening") { // attentive: wide open eyes, brows up a bit
        t.upper = Math.min(t.upper, .05) * .5; t.eye += .05; t.browY -= 6; t.iris *= 1.05;
        t.open = Math.min(t.open, .05);
      }
      target = t;
    }
    function onState(s) {
      const prev = state;
      state = s;
      if (s === "thinking") thinkSide = Math.random() < .5 ? -1 : 1;
      if (s === "listening" && prev !== "listening") setEmotion("neutral");
      if (prev === "speaking" && s !== "speaking") {
        // keep the reply's emotion for a moment, then relax
        clearTimeout(decayTimer);
        decayTimer = setTimeout(() => { emotion = "neutral"; recomputeTarget(); }, 2600);
      }
      if (Math.random() < .6) blink(); // natural blink on transitions
      nextSaccade = 0;
      recomputeTarget();
    }
    function blink(dur) {
      blinkStart = performance.now();
      blinkDur = dur || (emotion === "bored" ? 320 : rnd(130, 190));
    }
    function onPointer(clientX, clientY) {
      pointer.x = clientX; pointer.y = clientY; pointer.t = performance.now();
    }
    function wordBoundary() { wordPulse = 1; }
    function setDemoSpeaking(v) { demoSpeaking = v; }

    function blinkAmount(now) {
      if (blinkStart < 0) return 0;
      const p = (now - blinkStart) / blinkDur;
      if (p >= 1) {
        blinkStart = -1;
        if (doubleBlink) { doubleBlink = false; setTimeout(() => blink(), 90); }
        return 0;
      }
      return p < .4 ? p / .4 : 1 - (p - .4) / .6; // fast close, slower open
    }

    function updateGaze(now, dt) {
      const pointerFresh = now - pointer.t < 2500;
      let px = 0, py = 0;
      if (pointerFresh) {
        const r = svg.getBoundingClientRect();
        const dx = pointer.x - (r.left + r.width / 2), dy = pointer.y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1, m = Math.min(1, d / (r.width * .9));
        px = dx / d * m; py = dy / d * m;
      }
      if (state === "listening") {
        // look straight at the user (tiny micro-movements); slight pull toward the pointer
        if (now > nextSaccade) { gaze.tx = rnd(-.06, .06) + px * .25; gaze.ty = rnd(-.02, .08) + py * .25; nextSaccade = now + rnd(300, 900); }
      } else if (state === "thinking") {
        if (now > nextSaccade) { gaze.tx = thinkSide * rnd(.5, .75); gaze.ty = rnd(-.85, -.6); nextSaccade = now + rnd(700, 1600); }
      } else if (state === "speaking") {
        if (now > nextSaccade) {
          const away = Math.random() < .25;
          gaze.tx = away ? rnd(-.45, .45) : rnd(-.08, .08);
          gaze.ty = away ? rnd(-.3, .2) : rnd(-.05, .08);
          if (emotion === "sad") gaze.ty = rnd(.45, .7);
          if (emotion === "bored") { gaze.tx = rnd(.5, .7); gaze.ty = rnd(-.4, -.2); } // eye roll-ish
          nextSaccade = now + rnd(500, 1500);
        }
      } else { // idle
        if (pointerFresh) { gaze.tx = px; gaze.ty = py; }
        else if (now > nextSaccade) {
          const center = Math.random() < .3;
          gaze.tx = center ? 0 : rnd(-.85, .85);
          gaze.ty = center ? 0 : rnd(-.6, .6);
          if (emotion === "bored") gaze.ty = rnd(-.7, -.4);
          nextSaccade = now + rnd(800, 3200);
        }
      }
      const k = 1 - Math.exp(-dt * 16); // fast, saccade-like
      gaze.x += (gaze.tx - gaze.x) * k;
      gaze.y += (gaze.ty - gaze.y) * k;
    }

    function lidPaths(e, cy, rx, ry, upper, lower, tilt) {
      const top = cy - ry, bot = cy + ry;
      const xi = e.cx - e.side * (rx + 8), xo = e.cx + e.side * (rx + 8); // inner / outer x
      // upper lid edge
      const yu = top + upper * 2 * ry;
      const ti = tilt * ry * .55;
      const yuIn = yu + ti, yuOut = yu - ti;
      const bulge = ry * .24 * clamp(upper * 3);
      const cuy = (yuIn + yuOut) / 2 + 2 * bulge;
      const upperD = `M${f(xo)},${f(top - 80)} L${f(xi)},${f(top - 80)} L${f(xi)},${f(yuIn)} Q${f(e.cx)},${f(cuy)} ${f(xo)},${f(yuOut)} Z`;
      const lashD = `M${f(xi)},${f(yuIn)} Q${f(e.cx)},${f(cuy)} ${f(xo)},${f(yuOut)}`;
      // lower lid edge (curves up = "smiling eyes")
      const yl = bot - lower * 2 * ry;
      const bul = ry * .4 * clamp(lower * 3);
      const cly = yl - 2 * bul;
      const lowerD = `M${f(xo)},${f(bot + 80)} L${f(xi)},${f(bot + 80)} L${f(xi)},${f(yl)} Q${f(e.cx)},${f(cly)} ${f(xo)},${f(yl)} Z`;
      return [upperD, lowerD, lashD];
    }

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;

      // live levels
      const micL = Math.max(rms(micAnalyser), levels.fake), outL = rms(outAnalyser);
      levels.fake *= Math.exp(-dt * 2.5);
      levels.mic += (micL - levels.mic) * .35;
      levels.out += (outL - levels.out) * .45;

      // interpolate params toward target
      const k = SNAP ? 1 : 1 - Math.exp(-dt * 7);
      for (const key in target) cur[key] += (target[key] - cur[key]) * k;

      // blinking
      if (SNAP) blinkStart = -1;
      else if (now > nextBlink && blinkStart < 0) {
        doubleBlink = Math.random() < .15;
        blink();
        nextBlink = now + (state === "listening" ? rnd(3500, 7000) : rnd(2200, 6000));
      }
      const b = blinkAmount(now);

      updateGaze(now, dt);

      // speaking mouth
      if (state === "speaking") {
        if (outAnalyser && levels.out > .01) talkTarget = clamp(levels.out * 1.4);
        else if (demoSpeaking) {
          // synthetic syllables (speechSynthesis gives no audio stream to analyse)
          const t = now / 1000;
          const syl = .5 + .5 * Math.sin(t * 2 * Math.PI * 4.2 + Math.sin(t * 1.7) * 2);
          talkTarget = clamp(.15 + .55 * syl * (.6 + .4 * Math.sin(t * 2.3)) + wordPulse * .3);
        } else talkTarget = 0;
      } else talkTarget = 0;
      wordPulse *= Math.exp(-dt * 8);
      talk += (talkTarget - talk) * (1 - Math.exp(-dt * 22));

      const t = now / 1000;
      // ---- head
      const breathe = Math.sin(t * 1.5) * 3;
      const lvl = state === "listening" ? levels.mic : state === "speaking" ? Math.max(levels.out, talk * .6) : 0;
      let shake = 0;
      if (state === "speaking" && emotion === "angry") shake = Math.sin(t * 38) * 1.4 * talk;
      const hx = gaze.x * 7 + shake;
      const hy = breathe + gaze.y * 4 - (state === "listening" ? 4 : 0) - lvl * 6;
      const rot = gaze.x * 3 + cur.headTilt;
      const sc = 1 + (state === "listening" ? .02 : 0) + lvl * .03;
      head.setAttribute("transform", `translate(${f(hx)},${f(hy)}) rotate(${f(rot)}) scale(${f(sc)})`);
      heat.setAttribute("opacity", f(clamp(cur.heat)));
      blushL.setAttribute("opacity", f(clamp(cur.blush)));
      blushR.setAttribute("opacity", f(clamp(cur.blush)));

      // glow + shadow
      const gBase = { idle: .55 + Math.sin(t * 1.5) * .1, listening: .8, thinking: .6 + Math.sin(t * 4) * .12, speaking: .75 }[state] ?? .6;
      const gs = .92 + lvl * .35 + (state === "idle" ? Math.sin(t * 1.5) * .03 : 0);
      glow.setAttribute("opacity", f(clamp(gBase + lvl * .4)));
      glow.setAttribute("transform", `scale(${f(gs)})`);
      shadow.setAttribute("rx", f(110 - hy * 1.5));
      shadow.setAttribute("opacity", f(.4 - hy * .006));

      // ---- eyes
      for (const side of ["L", "R"]) {
        const e = eyes[side];
        const rx = EYE_RX * cur.eye, ry = EYE_RY * cur.eye;
        const asymU = side === "L" ? -cur.upperAsym : cur.upperAsym;
        const upper = clamp(cur.upper + asymU);
        const u = clamp(upper + (1 - upper) * b);
        const lo = clamp(cur.lower + b * .12, 0, .5);
        e.clip.setAttribute("rx", f(rx)); e.clip.setAttribute("ry", f(ry));
        e.sclera.setAttribute("rx", f(rx)); e.sclera.setAttribute("ry", f(ry));
        // pupils (+ slight convergence when looking at the user)
        const conv = state === "listening" ? -e.side * 2 : 0;
        const ix = e.cx + gaze.x * rx * .42 + conv;
        const iy = EYE_CY + gaze.y * ry * .38;
        const is = cur.iris * (state === "listening" ? 1 + levels.mic * .08 : 1);
        e.iris.setAttribute("transform", `translate(${f(ix)},${f(iy)}) scale(${f(is)})`);
        // lids
        const [ud, ld, lash] = lidPaths(e, EYE_CY, rx, ry, u, lo, cur.tilt);
        e.lidU.setAttribute("d", ud);
        e.lidL.setAttribute("d", ld);
        e.lash.setAttribute("d", lash);
        e.lash.setAttribute("opacity", f(clamp(u * 6)));
        // brow
        const asymB = side === "L" ? -cur.browAsym : cur.browAsym * .5;
        const by = EYE_CY - ry - 22 + cur.browY + asymB - b * 4 + (state === "listening" ? -levels.mic * 6 : 0);
        const xIn = e.cx - e.side * 24, xOut = e.cx + e.side * 40;
        const yIn = by + cur.browIn, yOut = by + cur.browOut + 4;
        const cx = (xIn + xOut) / 2, cy = (yIn + yOut) / 2 - cur.browCurve * 10;
        e.brow.setAttribute("d", `M${f(xOut)},${f(yOut)} Q${f(cx)},${f(cy)} ${f(xIn)},${f(yIn)}`);
      }

      // ---- mouth (cubic curves so "surprised" reads as a round O)
      const w = 46 * cur.mouthW * (1 - talk * .12);
      const s = cur.smile, sk = cur.skew;
      const open = clamp(cur.open + talk * .75, 0, 1.1);
      const yL = MOUTH_Y - s * 14 + sk * 8, yR = MOUTH_Y - s * 14 - sk * 8;
      const yc = (yL + yR) / 2;
      const midU = MOUTH_Y + s * 6 - open * 16, midD = MOUTH_Y + s * 6 + open * 34 + 1.5;
      const cu = (8 * midU - 2 * yc) / 6, cd = (8 * midD - 2 * yc) / 6;
      mouth.setAttribute("d",
        `M${f(-w)},${f(yL)} C${f(-w * .55)},${f(cu)} ${f(w * .55)},${f(cu)} ${f(w)},${f(yR)} ` +
        `C${f(w * .55)},${f(cd)} ${f(-w * .55)},${f(cd)} ${f(-w)},${f(yL)} Z`);

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return { setEmotion, onState, onPointer, blink, wordBoundary, setDemoSpeaking, get emotion() { return emotion; } };
  })();

  // ---------------------------------------------------------------------------
  // DEMO MODE — Web Speech API + canned rude replies
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // DEMO MODE — Web Speech API + canned rude replies
  // ---------------------------------------------------------------------------
  // Platform quirks
  const UA = navigator.userAgent || "";
  const IS_IOS = /iP(hone|od|ad)/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(UA);
  const IS_MOBILE = IS_IOS || IS_ANDROID || !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  // A second getUserMedia stream (eye/brow level meter) running next to SpeechRecognition degrades or
  // breaks recognition on Android and switches iOS into "play-and-record" (quiet earpiece output).
  // So the extra mic meter is desktop-only; on phones the face reacts to recognition events instead.
  const USE_MIC_METER = !IS_MOBILE;
  const synth = window.speechSynthesis || null;
  const HAS_TTS = !!(synth && window.SpeechSynthesisUtterance);
  const tidy = (t) => String(t || "").replace(/\s+/g, " ").trim();

  // Safari 16.4+ Audio Session API: "playback" = loudspeaker category (not the earpiece, not silenced by
  // the ring/silent switch); "auto" lets WebKit pick play-and-record while the mic is in use.
  function setAudioSession(type) {
    try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch {}
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let langMode = localStorage.getItem(LS.lang) === "IT" ? "IT" : "EN"; // EN (en-US, default) | IT (it-IT)
  let demoMicStream = null;

  function recLang() { return langMode === "IT" ? "it-IT" : "en-US"; }

  // --- voices. Mobile: getVoices() is empty at first and fills in later (voiceschanged, or just polling
  // on iOS). Android may report "en_US" instead of "en-US".
  let voices = [];
  const bcp47 = (l) => String(l || "").replace(/_/g, "-");
  const normLang = (l) => bcp47(l).toLowerCase();
  function loadVoices() {
    try { voices = HAS_TTS ? (synth.getVoices() || []) : []; } catch { voices = []; }
    return voices;
  }
  function onSynth(type, fn) {
    if (!HAS_TTS) return () => {};
    if (synth.addEventListener) { synth.addEventListener(type, fn); return () => synth.removeEventListener(type, fn); }
    synth["on" + type] = fn; return () => { if (synth["on" + type] === fn) synth["on" + type] = null; };
  }
  let voicesWait = null;
  function voicesReady(timeout = 1500) {
    if (!HAS_TTS || loadVoices().length) return Promise.resolve(voices);
    if (!voicesWait) voicesWait = new Promise((resolve) => {
      let done = false, poll = 0, to = 0, off = () => {};
      const finish = () => {
        if (done) return;
        done = true; clearInterval(poll); clearTimeout(to); off();
        loadVoices(); voicesWait = null; resolve(voices);
      };
      const check = () => { if (loadVoices().length) finish(); };
      off = onSynth("voiceschanged", check);
      poll = setInterval(check, 250);
      to = setTimeout(finish, timeout); // fallback: speak without an explicit voice (lang only)
    });
    return voicesWait;
  }
  if (HAS_TTS) { loadVoices(); onSynth("voiceschanged", loadVoices); voicesReady(4000); }

  const badVoices = new Set(); // voices that failed to start -> never chosen again
  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Grandma|Grandpa)\b/;
  // Returns an installed voice for "en"/"it" or null. With null the utterance gets only .lang
  // (setting a null/wrong voice can mute speech on mobile).
  function pickVoice(lang) {
    const want = lang === "it" ? "it" : "en";
    const list = voices.filter((v) => v && !badVoices.has(v.voiceURI || v.name) && normLang(v.lang).startsWith(want));
    if (!list.length) return null;
    const prefs = lang === "it"
      ? ["Google italiano", "Alice", "Luca", "Federica", "Paola"]
      : ["Daniel", "Google UK English Male", "Microsoft Ryan", "Arthur", "Microsoft George", "Samantha", "Google US English"];
    for (const p of prefs) { const v = list.find((v) => v.name && v.name.includes(p)); if (v) return v; }
    const sane = list.filter((v) => !NOVELTY.test(v.name || ""));
    const local = sane.filter((v) => v.localService !== false); // network voices can be silent offline
    const pool = local.length ? local : sane;
    for (const code of (lang === "it" ? ["it-it"] : ["en-gb", "en-us"])) {
      const v = pool.find((v) => normLang(v.lang) === code && v.default) || pool.find((v) => normLang(v.lang) === code);
      if (v) return v;
    }
    return pool.find((v) => v.default) || pool[0] || null;
  }

  // --- heuristics
  const IT_WORDS = new Set(("ciao sono sei siamo siete è ho hai abbiamo non perché perche grazie prego buongiorno buonasera " +
    "buonanotte io tu lui lei noi voi loro mi ti ci vi della dello delle degli del nel nella questo questa quello quella " +
    "cosa dove quando bene male allora però pero anche molto scusa scusi parlo parli inglese italiano voglio vorrei posso " +
    "fare oggi ieri domani adesso sempre niente nulla tutto tutti come stai va cioè cioe ecco dai boh insomma tipo").split(" "));
  const AMBIGUOUS = new Set(["come", "tipo", "dai", "fare", "male", "lei", "loro", "ecco"]);

  function looksItalian(text) {
    const words = text.toLowerCase().replace(/[^\p{L}' ]/gu, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    let hits = 0;
    for (const w of words) if (IT_WORDS.has(w) && !AMBIGUOUS.has(w)) hits++;
    return hits >= 2 || hits / words.length >= .34 || /[àèéìòù]/.test(text);
  }

  const NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|many|a few|several)";
  const THIRD = { go: "goes", have: "has", do: "does", want: "wants", like: "likes", say: "says", make: "makes",
    work: "works", live: "lives", need: "needs", know: "knows", think: "thinks", watch: "watches", play: "plays" };
  const BASEV = { went: "go", saw: "see", ate: "eat", came: "come", took: "take", did: "do", made: "make",
    had: "have", bought: "buy", said: "say", got: "get", wrote: "write", spoke: "speak", knew: "know" };
  const ADJ = { hunger: "hungry", thirst: "thirsty", sleep: "sleepy", cold: "cold", hot: "hot", fear: "scared" };
  const MODALS = "(?<!\\b(?:does|did|do|can|could|will|would|should|shall|must|might|may|don't|doesn't|didn't|won't|can't|let|to)\\s)";

  // [regex, replacement (string|fn), short Italian explanation]
  const RULES = [
    [new RegExp(`\\bi have ${NUM} years( old)?\\b(?! of| ago| experience)`, "i"), (m, n) => `I am ${n} years old`,
      "L'età si dice con il verbo to be: I am thirty years old, non I have."],
    [/\bi(?:'m| am) agree\b/i, "I agree", "Agree è già un verbo: si dice I agree, senza am."],
    [/\b(he|she|it) don'?t\b/i, (m, p) => `${p} doesn't`, "Con he, she, it si usa doesn't, non don't."],
    [/\bpeople is\b/i, "people are", "People è plurale: people are."],
    [/\bexplain me (this|that|it)\b/i, (m, w) => `explain ${w} to me`, "Si dice explain it to me: explain non regge me direttamente."],
    [/\bexplain me\b/i, "explain to me", "Si dice explain to me, oppure explain it to me."],
    [new RegExp(`\\bi (live|work|study) (here |in \\w+ )?since ${NUM} (years?|months?|weeks?|days?)\\b`, "i"),
      (m, v, place, n, u) => `I have ${{ live: "lived", work: "worked", study: "studied" }[v.toLowerCase()]} ${place || ""}for ${n} ${u}`,
      "Per qualcosa che dura ancora si usa il present perfect con for: I have lived here for three years."],
    [new RegExp(`\\bsince ${NUM} (years?|months?|weeks?|days?|hours?)\\b`, "i"), (m, n, u) => `for ${n} ${u}`,
      "Per una durata si usa for: for three years. Since solo con un momento preciso, tipo since 2020."],
    [/\bmore (better|worse|bigger|smaller|easier|faster|cheaper|older|younger|happier)\b/i, (m, a) => a,
      "È già un comparativo: niente more davanti."],
    [/\bi(?:'m| am) (boring)\b/i, "I'm bored", "Boring vuol dire noioso. Annoiato si dice bored."],
    [new RegExp(`${MODALS}\\b(he|she) (go|have|do|want|like|say|make|work|live|need|know|think|watch|play)\\b(?!n't)`, "i"),
      (m, p, v) => `${p} ${THIRD[v.toLowerCase()]}`, "Terza persona singolare: ci vuole la s. He goes, she has."],
    [/\bthe life is\b/i, "life is", "Per i concetti generali niente articolo: life is beautiful."],
    [/\bi (?:didn't|did not) (went|saw|ate|came|took|did|made|had|bought|said|got|wrote|spoke|knew)\b/i,
      (m, v) => `I didn't ${BASEV[v.toLowerCase()]}`, "Dopo didn't il verbo resta alla forma base: I didn't go."],
    [/\bmake a (photo|picture)\b/i, (m, p) => `take a ${p}`, "Fare una foto in inglese è take a photo, non make."],
    [/\bdepends? of\b/i, "depends on", "Si dice depends on, non of."],
    [/\bi(?:'m| am) born\b/i, "I was born", "Nato si dice I was born, al passato."],
    [/\bin (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m, d) => `on ${d[0].toUpperCase()}${d.slice(1)}`,
      "Con i giorni della settimana si usa on: on Monday."],
    [/\bwhat means (\w+)\b/i, (m, w) => `what does ${w} mean`, "Nelle domande serve does: what does it mean?"],
    [/\bhow (is|are) (it|this|that|he|she|they|you) called\b/i, (m, a, b) => `what ${a} ${b} called`,
      "Si dice what is it called, non how is it called."],
    [/\bi want that you\b/i, "I want you to", "Si dice I want you to do it, non I want that you."],
    [/\bi have (hunger|thirst|sleep|fear)\b/i, (m, n) => `I am ${ADJ[n.toLowerCase()]}`,
      "Fame, sete, sonno e paura si dicono con to be: I'm hungry."],
    [/\b(informations|advices|furnitures|homeworks)\b/i, (m, w) => w.slice(0, -1),
      "Information, advice e homework non hanno il plurale in inglese."],
    [/\bgo to home\b/i, "go home", "Home senza to: I go home."],
  ];

  function findMistakes(text) {
    let fixed = text;
    const notes = [];
    for (const [re, rep, note] of RULES) {
      if (re.test(fixed)) { fixed = fixed.replace(re, rep); notes.push(note); }
    }
    if (!notes.length) return null;
    fixed = fixed.replace(/\bi\b/g, "I").trim();
    fixed = fixed.charAt(0).toUpperCase() + fixed.slice(1);
    return { fixed, notes };
  }

  const recent = [];
  function pick(arr) {
    const pool = arr.filter((x) => !recent.includes(x));
    const choice = (pool.length ? pool : arr)[Math.floor(Math.random() * (pool.length || arr.length))];
    recent.push(choice); if (recent.length > 8) recent.shift();
    return choice;
  }
  const en = (text) => ({ lang: "en", text });
  const it = (text) => ({ lang: "it", text });

  const R = {
    nohear: [
      { emotion: "bored", segs: [en("Hello? I can't hear a damn thing. Tap me and actually say something.")] },
      { emotion: "annoyed", segs: [en("Was that silence? Bloody brilliant. Speak, for God's sake.")] },
      { emotion: "sad", segs: [en("Nothing. Absolutely nothing. I'm wasting my life here. Try again.")] },
    ],
    mumble: [
      { emotion: "surprised", segs: [en("What the hell was that? Italian? Klingon? Say it again, slowly, like a human being.")] },
      { emotion: "annoyed", segs: [en("I understood exactly none of that. Speak up, and open your bloody mouth.")] },
    ],
    greeting: [
      { emotion: "bored", segs: [en("Oh, look who showed up. Hi. Now say something more interesting than hello, I'm dying of boredom.")] },
      { emotion: "bored", segs: [en("Hello, hello. Wow. Groundbreaking. Tell me what you did yesterday. In English. Full sentences.")] },
      { emotion: "happy", segs: [en("Well, well, my favourite disaster is back. Go on then, tell me about your day.")] },
    ],
    howareyou: [
      { emotion: "sad", segs: [en("How am I? Stuck teaching you, that's how. Bloody marvellous. Now you: how are you, and why?")] },
    ],
    ciao: [
      { emotion: "angry", segs: [en("Ciao? Ciao?! Damn it, we say hello, or hi. Again: hello!"),
        it("Ciao in inglese è hi o hello quando arrivi, e bye quando te ne vai.")] },
    ],
    italian: [
      { emotion: "angry", segs: [en("What the hell? That's Italian! This is an English lesson, you muppet."),
        it("Ho capito, ma adesso dillo in inglese."), en("Come on. In English. Now.")] },
      { emotion: "sad", segs: [en("Oh, bloody hell. Italian again. I'm going to cry. Actually crying."),
        it("Prova a dirlo in inglese, anche con errori. È così che si impara."), en("Go on.")] },
      { emotion: "angry", segs: [en("Nope. Not having it. Speak English or I'm leaving."),
        it("Anche una frase semplice va bene, tipo: I don't know how to say it."), en("Try.")] },
    ],
    short: [
      { emotion: "annoyed", segs: [en("That's it? Two words? Give me a full sentence, damn it. Subject, verb, the whole bloody thing."),
        it("Rispondi con una frase completa, non con una parola.")] },
      { emotion: "bored", segs: [en("Wow, so chatty. Try a real sentence, like: I went to the shops yesterday.")] },
      { emotion: "bored", segs: [en("Riveting. Absolutely riveting. More words, please, before I fall asleep.")] },
    ],
    mistakeIntro: [
      { emotion: "angry", text: "Oh, for God's sake. Wrong!" },
      { emotion: "angry", text: "What the hell was that?" },
      { emotion: "annoyed", text: "Bloody hell, my ears are bleeding." },
      { emotion: "angry", text: "Nope. Damn it, no." },
      { emotion: "sad", text: "Oh no. Oh no no no. That was painful." },
    ],
    mistakeOutro: ["Again. Now.", "Repeat it, and don't screw it up this time.", "Go on, say it right.", "Say it. Properly."],
    correct: [
      { emotion: "happy", segs: [en("Hmph. Fine. That was actually correct. Don't let it go to your head. Now tell me more.")] },
      { emotion: "surprised", segs: [en("Wait, what? No mistakes? Who are you and what have you done with my student?")] },
      { emotion: "happy", segs: [en("Not bad. Not bloody good either, but not bad. Keep going.")] },
      { emotion: "sad", segs: [en("No mistakes? Damn. I had such a beautiful insult ready. Now I'm sad. Say something else.")] },
      { emotion: "happy", segs: [en("Look at you, speaking like a grown-up. Keep going before you ruin it.")] },
    ],
    question: [
      { emotion: "thinking", segs: [en("Hmm. Good question. Shame I'm only the demo version, I just shout at people. Put an API key in the settings and ask the real me.")] },
    ],
  };

  function demoReply(text, confidence) {
    const t = (text || "").trim();
    const low = t.toLowerCase();
    const words = low.split(/\s+/).filter(Boolean);
    if (!t) return pick(R.nohear);
    if (/^(ciao|salve)\b/.test(low)) return pick(R.ciao);
    if (looksItalian(t)) return pick(R.italian);
    if (langMode === "EN" && confidence > 0 && confidence < .3 && words.length > 1) return pick(R.mumble);
    const m = findMistakes(t);
    if (m) {
      const intro = pick(R.mistakeIntro);
      return { emotion: intro.emotion, segs: [en(intro.text), en(`Say it properly: ${m.fixed}.`), it(m.notes[0]), en(pick(R.mistakeOutro))] };
    }
    if (/^(hi|hello|hey|good (morning|afternoon|evening)|hiya|yo)\b/.test(low) && words.length <= 4) return pick(R.greeting);
    if (/how are you/.test(low)) return pick(R.howareyou);
    if (words.length <= 3) return pick(R.short);
    if (/^(what|why|how|can|could|do|does|is|are|where|when|who|which|would|will)\b/.test(low)) return pick(R.question);
    return pick(R.correct);
  }

  // --- TTS (speechSynthesis) with the mobile / Chrome workarounds:
  //  * unlock: the first tap synchronously does cancel() + speak(" ") before anything async. iOS and
  //    Android only play speech that was first started from a user gesture; later async speak() works.
  //  * voice only set when an installed voice matches; .lang always set.
  //  * resume() before speak, utterances kept referenced (Chrome GC drops their events otherwise),
  //    text chunked into sentences (Chrome cuts long utterances off), watchdog for stalls/missing onend.
  //  * recognition + mic are stopped before speaking (iOS routes output to the earpiece while capturing).
  const tts = { queue: [], active: false, keep: [], gen: 0, startedAny: false, hintShown: false, opts: {}, full: "" };
  let ttsUnlocked = false, unlockUtter = null;
  const MUTE_HINT = "Не слышно? Проверь беззвучный режим и громкость";

  function unlockTTS() {
    if (!HAS_TTS || ttsUnlocked) return;
    ttsUnlocked = true;
    try {
      synth.cancel();
      unlockUtter = new SpeechSynthesisUtterance(" ");
      unlockUtter.lang = "en-US";
      unlockUtter.volume = 0.01;
      synth.resume();
      synth.speak(unlockUtter);
    } catch (e) { console.warn("TTS unlock failed", e); }
    loadVoices();
  }

  function splitSentences(text, max = 160) {
    const parts = tidy(text).match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) || [];
    const out = [];
    let cur = "";
    const push = (s) => { s = tidy(s); if (s) out.push(s); };
    for (let p of parts) {
      p = tidy(p);
      if (!p) continue;
      while (p.length > max) { // overlong sentence: cut at a comma, else at a space
        let cut = p.lastIndexOf(", ", max);
        if (cut < max * 0.4) cut = p.lastIndexOf(" ", max);
        if (cut < 20) cut = max;
        push(cur); cur = "";
        push(p.slice(0, cut + 1)); p = tidy(p.slice(cut + 1));
      }
      if (!p) continue;
      // glue very short bits ("Wrong!") to the next sentence so speech doesn't sound choppy
      if (cur && cur.length >= 40) { push(cur); cur = p; }
      else if (cur && (cur + " " + p).length > max) { push(cur); cur = p; }
      else cur = cur ? cur + " " + p : p;
    }
    push(cur);
    return out;
  }

  // opts: { sync: speak synchronously (inside a click), prefix: caption prefix, keepCaption,
  //         onStart(), onNoStart(), onDone(started) }
  function speak(segs, emotion, opts = {}) {
    const wasListening = !!rec;
    stopRecognition();
    stopDemoMic();
    face.setEmotion(emotion === "annoyed" ? "bored" : emotion);
    const full = segs.map((s) => s.text).join(" ");
    if (!opts.keepCaption) caption((opts.prefix ? opts.prefix + "\n" : "") + "— " + full);
    if (!HAS_TTS) {
      caption("🔇 Озвучка (speechSynthesis) недоступна в этом браузере.\n— " + full, { force: true, err: true });
      setState("idle");
      return;
    }
    setAudioSession("playback");
    const gen = ++tts.gen;
    tts.queue = [];
    for (const s of segs) splitSentences(s.text).forEach((t, i) => tts.queue.push({ lang: s.lang, text: t, gap: i ? 40 : 170 }));
    tts.active = true; tts.startedAny = false; tts.opts = opts; tts.full = full; tts.keep = [];
    setState("speaking");
    face.setDemoSpeaking(true);
    let busy = false;
    try { busy = synth.speaking || synth.pending; } catch {}
    if (busy) { try { synth.cancel(); } catch {} }
    // Chrome can drop a speak() issued right after cancel(); outside a gesture a short delay is harmless.
    if (!opts.sync && wasListening) setTimeout(() => nextUtterance(gen), REC_TO_TTS_GAP);
    else if (busy && !opts.sync) setTimeout(() => nextUtterance(gen), 90);
    else nextUtterance(gen);
  }
  function nextUtterance(gen) {
    if (!tts.active || gen !== tts.gen) return;
    const seg = tts.queue.shift();
    if (!seg) { ttsFinished(gen); return; }
    speakChunk(seg, gen, true);
  }
  function ttsFinished(gen) {
    if (gen !== tts.gen) return;
    tts.active = false; tts.keep = [];
    face.setDemoSpeaking(false);
    setAudioSession("auto");
    if (!tts.startedAny) noAudioHint(MUTE_HINT, false); // ended/failed without ever starting
    try { tts.opts.onDone?.(tts.startedAny); } catch {}
    setState("idle");
  }
  function noAudioHint(msg = MUTE_HINT, withCaption = true) {
    try { tts.opts.onNoStart?.(); } catch {}
    if (tts.hintShown) return;
    tts.hintShown = true; // one-time
    toast(msg, 6500, true);
    if (withCaption && tts.full && !tts.opts.keepCaption) caption((tts.opts.prefix ? tts.opts.prefix + "\n" : "") + "— " + tts.full, { force: true });
  }
  function speakChunk(seg, gen, allowVoice) {
    const u = new SpeechSynthesisUtterance(seg.text);
    const v = allowVoice ? pickVoice(seg.lang) : null;
    if (v) { u.voice = v; u.lang = bcp47(v.lang); }
    else u.lang = seg.lang === "it" ? "it-IT" : "en-US";
    u.rate = seg.lang === "it" ? 1.02 : 0.97;
    u.pitch = 0.9;
    u.volume = 1;
    const t0 = performance.now();
    const maxMs = 6000 + seg.text.length * 120;
    let started = false, done = false, quietSince = 0, hinted = false, wd = 0;
    const stop = () => { done = true; clearInterval(wd); };
    const next = () => {
      if (done) return;
      stop();
      if (gen !== tts.gen || !tts.active) return;
      face.setDemoSpeaking(false);
      const gap = tts.queue[0]?.gap ?? 0;
      setTimeout(() => { if (gen !== tts.gen || !tts.active) return; face.setDemoSpeaking(true); nextUtterance(gen); }, gap);
    };
    const giveUp = () => { // nothing ever started: don't grind through every chunk silently
      stop();
      try { synth.cancel(); } catch {}
      if (gen !== tts.gen) return;
      caption((tts.opts.prefix ? tts.opts.prefix + "\n" : "") + "🔇 " + tts.full, { force: true, err: true });
      ttsFinished(gen);
    };
    const retryWithoutVoice = (why) => {
      if (done) return;
      dbg("TTS: retry without explicit voice", v && v.name, why);
      if (v) badVoices.add(v.voiceURI || v.name);
      stop();
      try { synth.cancel(); } catch {}
      setTimeout(() => { if (gen === tts.gen && tts.active) speakChunk(seg, gen, false); }, 80);
    };
    u.onstart = () => {
      if (done) return;
      started = true;
      if (!tts.startedAny) { tts.startedAny = true; try { tts.opts.onStart?.(); } catch {} }
    };
    u.onboundary = () => face.wordBoundary();
    u.onend = () => next();
    u.onerror = (e) => {
      const err = (e && e.error) || "";
      dbg("TTS error:", err);
      if (done) return;
      if (err === "interrupted" || err === "canceled") return next();
      if (!started && v && /voice|language|synthesis/.test(err)) return retryWithoutVoice(err);
      if (err === "not-allowed") { ttsUnlocked = false; noAudioHint("Браузер заблокировал звук — нажми на лицо ещё раз"); }
      if (!started && !tts.startedAny) return giveUp();
      next();
    };
    wd = setInterval(() => { // watchdog
      if (done) return;
      if (gen !== tts.gen) { stop(); return; }
      const now = performance.now(), el = now - t0;
      let speaking = false, pending = false, paused = false;
      try { speaking = synth.speaking; pending = synth.pending; paused = synth.paused; } catch {}
      if (paused) { try { synth.resume(); } catch {} } // Chrome/Android sometimes leaves the queue paused
      if (!started) {
        if (el > 2000 && !hinted && !tts.startedAny) { hinted = true; noAudioHint(); }
        if (el > 3000 && v) return retryWithoutVoice("no onstart in 3s");
        if (el > 6000) { if (!tts.startedAny) return giveUp(); try { synth.cancel(); } catch {} return next(); }
      } else if (!speaking && !pending) {
        if (!quietSince) quietSince = now; // Chrome sometimes never fires onend
        else if (now - quietSince > 1200) return next();
      } else quietSince = 0;
      if (el > maxMs) { try { synth.cancel(); } catch {} next(); }
    }, 300);
    tts.keep.push(u);
    try { synth.resume(); } catch {}
    try { synth.speak(u); } catch (e) { console.error(e); if (!tts.startedAny) giveUp(); else next(); }
  }
  function stopSpeaking() {
    tts.gen++;
    const wasActive = tts.active;
    tts.active = false; tts.queue = [];
    face.setDemoSpeaking(false);
    // only cancel our own speech (cancelling the just-spoken unlock utterance is pointless)
    if (HAS_TTS && wasActive) { try { synth.cancel(); } catch {} }
  }

  // "Проверить звук" (settings): speaks synchronously inside the click, reports what happened
  function testSound() {
    const st = soundStatus;
    st.hidden = false;
    if (!HAS_TTS) { st.textContent = "✗ speechSynthesis недоступен в этом браузере."; return; }
    if (realSession) { st.textContent = "Сначала заверши LIVE-сессию (нажми на лицо)."; return; }
    ttsUnlocked = true; // this very tap unlocks speech
    loadVoices();
    const v = pickVoice("en");
    const info = `\nГолосов: ${voices.length} · ${v ? v.name + " (" + bcp47(v.lang) + ")" : "системный голос en-US"}`;
    st.textContent = "▶ Говорю тестовую фразу…" + info;
    speak([en("Hello! This is Mister Grumble. If you can hear me, the sound works.")], "happy", {
      sync: true,
      prefix: "🔊 тест звука",
      onStart: () => { st.textContent = "✓ Речь запущена. Если тихо — прибавь громкость, на iPhone проверь беззвучный режим (переключатель сбоку)." + info; },
      onNoStart: () => { st.textContent = "✗ Речь не стартовала. " + MUTE_HINT + ", затем нажми ещё раз." + info; },
    });
  }

  // --- recognition: lang set explicitly, interim results, 3 alternatives, auto-stop after silence
  let rec = null; // current session { r, final, interim, conf, alts, error, stopping, timers }
  let recEndedAt = -1e9; // iOS: give the audio session ~300 ms to leave "record" mode before speaking
  const REC_TO_TTS_GAP = 350;
  const DICTATION_HINT = "Включи Диктовку в Настройки → Основные → Клавиатура";
  // Safari (esp. continuous mode) may repeat/accumulate transcripts across results -> merge, don't duplicate
  function mergeText(acc, piece) {
    piece = tidy(piece);
    if (!piece) return acc;
    if (!acc) return piece;
    const a = acc.toLowerCase(), p = piece.toLowerCase();
    if (p.startsWith(a)) return piece;
    if (a.endsWith(p) || a.includes(p)) return acc;
    return acc + " " + piece;
  }

  function bestAlt(result) {
    let best = null, bc = -1;
    for (let j = 0; j < result.length; j++) {
      const a = result[j] || (result.item && result.item(j));
      if (!a || !a.transcript) continue;
      const c = typeof a.confidence === "number" ? a.confidence : 0; // Safari often reports 0
      if (c > bc) { best = a; bc = c; }
    }
    return best || { transcript: "", confidence: 0 };
  }
  function clearRecTimers(s) { clearTimeout(s.tNoSpeech); clearTimeout(s.tSilence); clearTimeout(s.tMax); clearTimeout(s.tEnd); }
  function detachRec(r) { r.onresult = r.onerror = r.onend = r.onspeechstart = r.onaudiostart = r.onnomatch = null; }

  // hard stop, no reply (before speaking, on tab hide, …)
  function stopRecognition() {
    const s = rec;
    if (!s) return;
    rec = null;
    recEndedAt = performance.now();
    clearRecTimers(s);
    detachRec(s.r);
    try { s.r.abort(); } catch {}
    stopDemoMic();
  }
  // graceful stop: recognizer delivers the final result, then onend -> reply
  function finishListening(s, why) {
    if (!s || rec !== s || s.stopping) return;
    s.stopping = why;
    dbg("recognition stop:", why);
    clearTimeout(s.tSilence); clearTimeout(s.tNoSpeech); clearTimeout(s.tMax);
    try { s.r.stop(); } catch {}
    s.tEnd = setTimeout(() => { // some engines (iOS) occasionally never fire onend after stop()
      if (rec !== s) return;
      rec = null; recEndedAt = performance.now(); detachRec(s.r);
      try { s.r.abort(); } catch {}
      stopDemoMic();
      onRecognitionEnd(s);
    }, 2000);
  }

  function srUnavailable() {
    setState("idle", "Распознавание речи недоступно");
    face.setEmotion("sad");
    caption(IS_IOS
      ? "Распознавание речи недоступно. " + DICTATION_HINT + " (и Siri), обнови iOS и открой страницу в Safari. Или включи LIVE-режим с ключом OpenAI (⚙): он слышит намного лучше."
      : "Этот браузер не умеет распознавать речь. Открой страницу в свежем Chrome (Android) или Safari (iPhone, iOS 14.5+). Или включи LIVE-режим с ключом OpenAI (⚙): он слышит намного лучше.", { force: true, err: true });
  }

  function startListening() {
    if (!SR) { srUnavailable(); return; }
    stopSpeaking();
    stopRecognition();
    setAudioSession("auto");
    if (USE_MIC_METER) ensureAudioCtx();
    let r;
    try { r = new SR(); } catch (e) { console.error(e); srUnavailable(); return; }
    const s = (rec = { r, final: "", interim: "", conf: 0, alts: [], error: "", stopping: "" });
    r.lang = recLang();
    // continuous=false everywhere except iOS: WebKit ends non-continuous sessions almost immediately,
    // often before the user has finished. Our own silence timer (below) stops it on every platform.
    r.continuous = IS_IOS;
    r.interimResults = true;
    r.maxAlternatives = 3;
    r.onspeechstart = () => {
      if (rec !== s) return;
      levels.fake = 0.5;
      if (appState === "listening") hintEl.textContent = "Слышу…";
    };
    r.onresult = (ev) => {
      if (rec !== s) return;
      let fin = "", inter = "", conf = 0, alts = [];
      for (let i = 0; i < ev.results.length; i++) { // rebuilt from all results (Android repeats them)
        const res = ev.results[i];
        const best = bestAlt(res);
        if (res.isFinal) {
          fin = mergeText(fin, best.transcript);
          conf = best.confidence || 0;
          alts = [];
          for (let j = 0; j < res.length; j++) {
            const t = tidy(res[j] && res[j].transcript);
            if (t && t !== tidy(best.transcript) && !alts.includes(t)) alts.push(t);
          }
        } else inter = mergeText(inter, best.transcript);
      }
      if (fin && inter && mergeText(fin, inter) === fin) inter = ""; // Safari repeats finals as interim
      s.final = tidy(fin); s.interim = tidy(inter); s.conf = conf; s.alts = alts;
      levels.fake = Math.max(levels.fake, 0.55);
      const shown = mergeText(s.final, s.interim);
      if (shown) caption("🎤 " + shown + (s.interim ? " …" : ""), { interim: !!s.interim });
      // auto-stop after a short silence (iOS Safari otherwise keeps listening; some Androids too)
      clearTimeout(s.tNoSpeech);
      clearTimeout(s.tSilence);
      s.tSilence = setTimeout(() => finishListening(s, "silence"), s.interim ? 1700 : 900);
    };
    r.onerror = (ev) => {
      if (rec !== s) return;
      s.error = (ev && ev.error) || "unknown";
      console.warn("SpeechRecognition error", s.error, (ev && ev.message) || "");
    };
    r.onend = () => {
      if (rec !== s) return;
      rec = null;
      recEndedAt = performance.now();
      clearRecTimers(s);
      stopDemoMic();
      onRecognitionEnd(s);
    };
    try {
      r.start();
    } catch (e) {
      console.error(e);
      rec = null;
      recFail("Не удалось запустить распознавание — нажми ещё раз", "sad");
      return;
    }
    setState("listening");
    caption("🎤 слушаю (" + r.lang + ")…", { interim: true });
    s.tNoSpeech = setTimeout(() => finishListening(s, "no-speech-timeout"), 8000);
    s.tMax = setTimeout(() => finishListening(s, "max-duration"), 15000);
    if (USE_MIC_METER) startDemoMic(s);
  }

  const REC_ERR = {
    "not-allowed": [IS_IOS
      ? "Нет доступа к микрофону или распознаванию. Разреши микрофон (Настройки → Safari → Микрофон, или «аА» в адресной строке → Настройки сайта). " + DICTATION_HINT + "."
      : "Нет доступа к микрофону. Разреши микрофон для этого сайта (значок у адресной строки).", "sad"],
    "service-not-allowed": ["Распознавание речи запрещено. " + DICTATION_HINT + ", включи Siri и разреши микрофон для Safari (Настройки → Safari → Микрофон).", "sad"],
    "audio-capture": ["Микрофон недоступен — не найден или занят другим приложением (звонок, диктофон). Закрой его и нажми ещё раз.", "bored"],
    "network": ["Ошибка сети распознавания: браузер отправляет звук на сервер распознавания — проверь интернет. LIVE-режим (ключ OpenAI) работает надёжнее.", "bored"],
    "language-not-supported": ["Этот язык распознавания не поддерживается браузером — переключи EN / IT внизу.", "sad"],
  };
  function recFail(msg, emo) {
    setState("idle");
    face.setEmotion(emo);
    caption(msg, { force: true, err: true });
    clearTimeout(recFail.t);
    recFail.t = setTimeout(() => { if (appState === "idle") face.setEmotion("neutral"); }, 6000);
  }
  function onRecognitionEnd(s) {
    const text = mergeText(s.final, s.interim);
    const err = s.error;
    dbg("recognition end", { err, text, conf: s.conf, alts: s.alts, why: s.stopping });
    if (!text && err === "aborted") {
      // iOS sometimes aborts by itself right after start (Siri/dictation off, or audio session busy)
      if (IS_IOS && !s.stopping) { recFail("Распознавание оборвалось. Нажми и говори сразу. Если повторяется: " + DICTATION_HINT + ".", "sad"); return; }
      setState("idle"); return;
    }
    if (!text && REC_ERR[err]) { recFail(...REC_ERR[err]); return; }
    if (!text && err && err !== "no-speech") { recFail("Ошибка распознавания (" + err + ") — нажми и попробуй ещё раз.", "sad"); return; }
    if (!text) { // 'no-speech' error, or our own silence timeout
      setState("thinking");
      face.setEmotion("sad");
      caption("Ничего не услышал 🙉 Говори громче и ближе к микрофону, сразу после нажатия.", { force: true, err: true });
      const reply = pick(R.nohear);
      setTimeout(() => speakReply(reply, { keepCaption: true }), 700);
      return;
    }
    const heard = "🎤 " + text + (s.alts.length ? "   (варианты: " + s.alts.join(" | ") + ")" : "");
    caption(heard);
    setState("thinking");
    const reply = demoReply(text, s.conf);
    setTimeout(() => speakReply(reply, { prefix: heard }), 450 + Math.random() * 600);
  }
  async function speakReply(reply, opts) {
    if (appState !== "thinking") return; // the user did something else meanwhile
    await voicesReady();
    const wait = REC_TO_TTS_GAP - (performance.now() - recEndedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (appState !== "thinking") return;
    speak(reply.segs, reply.emotion, opts);
  }

  // separate mic stream just for the level meter (desktop only, see USE_MIC_METER)
  async function startDemoMic(s) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (rec === s && appState === "listening") { stopDemoMic(); demoMicStream = stream; attachMic(stream); }
      else stream.getTracks().forEach((t) => t.stop());
    } catch { /* level meter is optional */ }
  }
  function stopDemoMic() {
    detachMic();
    demoMicStream?.getTracks().forEach((t) => t.stop());
    demoMicStream = null;
  }

  function demoTap() {
    if (appState === "idle") startListening();
    else if (appState === "listening") { if (rec) finishListening(rec, "tap"); else setState("idle"); }
    else if (appState === "speaking") { stopSpeaking(); startListening(); }
    // thinking: ignore
  }

  // ---------------------------------------------------------------------------
  // REAL MODE — OpenAI Realtime API over WebRTC (gpt-realtime-2.1-mini)
  // Flow (per OpenAI "Realtime API with WebRTC" guide, ephemeral-token variant):
  //  1. POST /v1/realtime/client_secrets with the standard key + session config -> { value: "ek_..." }
  //     (normally done by YOUR server; done in-browser here for personal local use only)
  //  2. RTCPeerConnection + mic track + data channel "oai-events", create SDP offer
  //  3. POST offer SDP to /v1/realtime/calls with Bearer ek_..., Content-Type application/sdp
  //  4. setRemoteDescription(answer). Audio flows over media tracks, JSON events over the data channel.
  // Fallback: if minting the client secret fails for a non-auth reason, try the "unified interface"
  // (multipart sdp + session to /v1/realtime/calls) with the standard key directly.
  // ---------------------------------------------------------------------------
  let realSession = null; // { pc, dc, mic, audioEl, ... }

  function voiceName() { return localStorage.getItem(LS.voice) || "cedar"; }

  function sessionConfig() {
    const cfg = {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: PERSONA,
      output_modalities: ["audio"],
      audio: { output: { voice: voiceName() } },
    };
    if (USE_EMOTION_TOOL) {
      cfg.tools = [{
        type: "function",
        name: "set_emotion",
        description: "Set the tutor avatar's facial expression for the reply you are about to speak. Call it once at the start of every reply, before speaking. Never mention it aloud.",
        parameters: {
          type: "object",
          properties: { emotion: { type: "string", enum: EMOTIONS } },
          required: ["emotion"],
        },
      }];
      cfg.tool_choice = "auto";
    }
    return cfg;
  }

  // keyword fallback for emotion when the model speaks without calling set_emotion
  function guessEmotion(text) {
    const s = text.toLowerCase();
    if (/(wrong|what the hell|for god'?s sake|damn it|no no|nope|bloody hell|crap|shit|seriously\?)/.test(s)) return "angry";
    if (/(wait,? what|wow|no mistakes|who are you)/.test(s)) return "surprised";
    if (/(not bad|correct|good job|well done|fine\.|not terrible|perfect)/.test(s)) return "happy";
    if (/(cry|sad|despair|my life|why me|painful)/.test(s)) return "sad";
    if (/(boring|riveting|yawn|asleep|whatever)/.test(s)) return "bored";
    if (/(hmm|let me think|interesting question)/.test(s)) return "thinking";
    return null;
  }

  async function connectRealtime() {
    const key = getKey();
    ensureAudioCtx();
    setState("thinking", HINTS.connecting);
    const S = (realSession = {
      pc: null, dc: null, mic: null, audioEl: null, closed: false,
      emotionSet: false, transcript: "", followUps: 0, speakingHold: 0, outSpeaking: false,
    });
    try {
      const pc = (S.pc = new RTCPeerConnection());
      const audioEl = (S.audioEl = document.createElement("audio"));
      audioEl.autoplay = true;
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
        audioEl.play().catch(() => toast("Нажми ещё раз, чтобы включить звук"));
        attachOut(e.streams[0]); // drive the mouth from the real audio level
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(pc.connectionState) && !S.closed) {
          disconnectRealtime("Соединение потеряно");
        }
      };

      S.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(S.mic.getAudioTracks()[0], S.mic);
      attachMic(S.mic);

      const dc = (S.dc = pc.createDataChannel("oai-events"));
      dc.addEventListener("message", (e) => { try { onRealtimeEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } });
      dc.addEventListener("close", () => { if (!S.closed) disconnectRealtime(); });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      let answerSdp;
      // 1) ephemeral client secret
      const tokRes = await fetch(`${OPENAI}/realtime/client_secrets`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session: sessionConfig() }),
      });
      if (tokRes.ok) {
        const data = await tokRes.json();
        const ek = data.value || data.client_secret?.value;
        if (!ek) throw new Error("No client secret in response");
        const sdpRes = await fetch(`${OPENAI}/realtime/calls`, {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: `Bearer ${ek}`, "Content-Type": "application/sdp" },
        });
        if (!sdpRes.ok) throw new Error(`realtime/calls ${sdpRes.status}: ${await sdpRes.text()}`);
        answerSdp = await sdpRes.text();
      } else if (tokRes.status === 401 || tokRes.status === 403 || tokRes.status === 429) {
        throw new Error(`client_secrets ${tokRes.status}: ${await errText(tokRes)}`);
      } else {
        // 2) fallback: unified interface with the standard key (multipart: sdp + session)
        console.warn("client_secrets failed", tokRes.status, await errText(tokRes), "- trying unified interface");
        const fd = new FormData();
        fd.set("sdp", offer.sdp);
        fd.set("session", JSON.stringify(sessionConfig()));
        const r = await fetch(`${OPENAI}/realtime/calls`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
        if (!r.ok) throw new Error(`realtime/calls ${r.status}: ${await errText(r)}`);
        answerSdp = await r.text();
      }
      if (S.closed) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      dbg("realtime: connected, waiting for session.created…");
    } catch (err) {
      console.error(err);
      caption("realtime error: " + (err.message || err), { force: true, err: true });
      disconnectRealtime(shortErr(err));
    }
  }
  async function errText(res) {
    const t = await res.text().catch(() => "");
    try { return JSON.parse(t).error?.message || t; } catch { return t; }
  }
  function shortErr(err) {
    const m = String(err?.message || err);
    if (/NotAllowed|Permission/i.test(m)) return "Нет доступа к микрофону";
    if (/401|Incorrect API key/i.test(m)) return "Неверный API-ключ";
    if (/429/.test(m)) return "Лимит/квота OpenAI (429)";
    return "Ошибка подключения — подробности в консоли";
  }

  function send(evt) {
    const dc = realSession?.dc;
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(evt));
  }

  function onRealtimeEvent(ev) {
    const S = realSession;
    if (!S) return;
    switch (ev.type) {
      case "session.created":
        // extra settings sent separately so an unsupported field can't break session creation
        send({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: { type: "semantic_vad", eagerness: "medium" },
                transcription: { model: "gpt-4o-mini-transcribe" }, // only for the debug caption
                noise_reduction: { type: "near_field" },
              },
            },
          },
        });
        // tutor opens the lesson
        send({
          type: "conversation.item.create",
          item: { type: "message", role: "system", content: [{ type: "input_text",
            text: "The student just connected. Greet them in character in one or two short sentences and ask what they want to practise today." }] },
        });
        send({ type: "response.create" });
        setState("thinking");
        break;

      case "input_audio_buffer.speech_started":
        setState("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        setState("thinking");
        break;

      case "response.created":
        S.emotionSet = false;
        S.transcript = "";
        S.hadAudio = false;
        break;

      case "response.output_item.done": {
        const item = ev.item;
        if (item?.type === "function_call" && item.name === "set_emotion") {
          let emo = "neutral";
          try { emo = JSON.parse(item.arguments || "{}").emotion || "neutral"; } catch {}
          face.setEmotion(emo);
          S.emotionSet = true;
          dbg("emotion: " + emo);
          send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify({ ok: true }) } });
        } else if (item?.type === "message") {
          S.hadAudio = true;
        }
        break;
      }

      case "response.output_audio_transcript.delta":
        S.hadAudio = true;
        S.transcript += ev.delta || "";
        if (!S.emotionSet && S.transcript.length > 12) {
          const g = guessEmotion(S.transcript);
          if (g) { face.setEmotion(g); S.emotionSet = true; }
        }
        break;
      case "response.output_audio_transcript.done":
        caption("— " + (ev.transcript || S.transcript));
        break;
      case "conversation.item.input_audio_transcription.completed":
        caption("🎤 " + ev.transcript);
        break;

      case "response.done": {
        const out = ev.response?.output || [];
        const calledTool = out.some((o) => o.type === "function_call");
        const spoke = S.hadAudio || out.some((o) => o.type === "message");
        // The model called set_emotion but did not speak yet -> ask it to speak now, without tools
        // (tool_choice "none" prevents a set_emotion loop).
        if (calledTool && !spoke && ev.response?.status === "completed" && S.followUps < 2) {
          S.followUps++;
          send({ type: "response.create", response: { tool_choice: "none" } });
        } else {
          S.followUps = 0;
        }
        if (ev.response?.status === "failed") {
          caption("response failed: " + JSON.stringify(ev.response.status_details));
        }
        break;
      }

      // WebRTC-specific: server-side output buffer playback
      case "output_audio_buffer.started":
        S.outSpeaking = true;
        setState("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        S.outSpeaking = false;
        if (appState === "speaking") setState("listening");
        break;

      case "error":
        console.error("Realtime error", ev.error);
        caption("realtime error: " + (ev.error?.message || JSON.stringify(ev)));
        break;
      default:
        break;
    }
  }

  // fallback "speaking" detection from the output level, in case buffer events are missing
  setInterval(() => {
    const S = realSession;
    if (!S || S.outSpeaking) return;
    if (levels.out > .05) { S.speakingHold = 8; if (appState !== "speaking") setState("speaking"); }
    else if (S.speakingHold > 0 && --S.speakingHold === 0 && appState === "speaking") setState("listening");
  }, 100);

  function disconnectRealtime(msg) {
    const S = realSession;
    if (!S) return;
    S.closed = true;
    realSession = null;
    try { S.dc?.close(); } catch {}
    try { S.pc?.getSenders().forEach((s) => s.track?.stop()); S.pc?.close(); } catch {}
    S.mic?.getTracks().forEach((t) => t.stop());
    if (S.audioEl) { S.audioEl.srcObject = null; S.audioEl.remove(); }
    detachMic(); detachOut();
    setState("idle", msg || HINTS.idle);
    if (msg) setTimeout(() => { if (appState === "idle" && !realSession) hintEl.textContent = HINTS.idle; }, 5000);
  }

  function realTap() {
    if (realSession) disconnectRealtime();
    else connectRealtime();
  }

  // ---------------------------------------------------------------------------
  // UI wiring
  // ---------------------------------------------------------------------------
  function tap() {
    unlockTTS(); // must stay FIRST and synchronous: speech has to be started inside the user gesture
    if (isReal() || realSession) { ensureAudioCtx(); realTap(); }
    else { if (USE_MIC_METER) ensureAudioCtx(); demoTap(); }
  }
  faceBtn.addEventListener("click", tap);
  // any first tap anywhere also unlocks speech (the sound-test button speaks by itself)
  const unlockAny = (e) => { if (!(e.target && e.target.closest && e.target.closest("#testSoundBtn"))) unlockTTS(); };
  document.addEventListener("click", unlockAny, true);
  document.addEventListener("touchend", unlockAny, true);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || realSession) return;
    stopRecognition();
    stopSpeaking();
    if (appState !== "idle") setState("idle");
    ttsUnlocked = false; // re-unlock on the next tap after coming back
  });

  window.addEventListener("pointermove", (e) => face.onPointer(e.clientX, e.clientY), { passive: true });
  window.addEventListener("pointerdown", (e) => face.onPointer(e.clientX, e.clientY), { passive: true });
  window.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (t) face.onPointer(t.clientX, t.clientY); }, { passive: true });

  function renderLang() { langBtn.textContent = langMode; }
  langBtn.addEventListener("click", () => {
    langMode = langMode === "EN" ? "IT" : "EN";
    localStorage.setItem(LS.lang, langMode);
    renderLang();
    toast(langMode === "EN" ? "Распознавание: English · en-US" : "Распознавание: Italiano · it-IT", 1800);
  });

  gearBtn.addEventListener("click", () => {
    keyInput.value = getKey();
    voiceSelect.value = voiceName();
    captionToggle.checked = captionOn;
    soundStatus.hidden = true;
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save") {
      const k = keyInput.value.trim();
      if (k) localStorage.setItem(LS.key, k); else localStorage.removeItem(LS.key);
      localStorage.setItem(LS.voice, voiceSelect.value);
      if (realSession) disconnectRealtime();
      refreshMode();
      toast(k ? "LIVE · OpenAI Realtime" : "DEMO");
    }
    setCaptionVisible(captionToggle.checked);
  });
  clearKeyBtn.addEventListener("click", () => {
    keyInput.value = "";
    localStorage.removeItem(LS.key);
    if (realSession) disconnectRealtime();
    refreshMode();
    toast("Ключ удалён · DEMO");
  });
  captionToggle.addEventListener("change", () => setCaptionVisible(captionToggle.checked));
  testSoundBtn.addEventListener("click", testSound);

  // hidden debug keys: E = cycle emotions, S = cycle states, C = caption, Space/Enter = tap
  let emoIdx = 0, stIdx = 0;
  const STATES = ["idle", "listening", "thinking", "speaking"];
  window.addEventListener("keydown", (e) => {
    if (dlg.open || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); if (!e.repeat) tap(); }
    else if (e.code === "KeyE") {
      emoIdx = (EMOTIONS.indexOf(face.emotion) + 1) % EMOTIONS.length;
      face.setEmotion(EMOTIONS[emoIdx]);
      toast("emotion · " + EMOTIONS[emoIdx]);
    } else if (e.code === "KeyS" && !realSession && !rec && !tts.active) {
      stIdx = (STATES.indexOf(appState) + 1) % STATES.length;
      const keep = face.emotion;
      setState(STATES[stIdx]);
      face.setDemoSpeaking(STATES[stIdx] === "speaking");
      if (STATES[stIdx] !== "listening") face.setEmotion(keep);
      toast("state · " + STATES[stIdx]);
    } else if (e.code === "KeyC") setCaptionVisible(captionEl.hidden);
  });

  // expose a tiny debug handle
  window.voiceTutor = {
    face, setState, demoReply, mergeText, findMistakes, looksItalian, splitSentences, pickVoice, bestAlt, testSound, speak,
    voicesReady, platform: { IS_IOS, IS_ANDROID, IS_MOBILE, USE_MIC_METER, HAS_TTS, HAS_SR: !!SR },
    get state() { return appState; }, get tts() { return tts; }, get rec() { return rec; }, get ttsUnlocked() { return ttsUnlocked; },
    get realSession() { return realSession; },
  };

  // init
  refreshMode();
  renderLang();
  setCaptionVisible(localStorage.getItem(LS.caption) !== "0"); // live caption on by default
  setState("idle");
  // preview helpers: ?emotion=angry&state=thinking
  const qp = new URLSearchParams(location.search);
  if (qp.get("state") && ["idle", "listening", "thinking", "speaking"].includes(qp.get("state"))) {
    setState(qp.get("state"));
    face.setDemoSpeaking(qp.get("state") === "speaking");
  }
  if (qp.get("emotion")) face.setEmotion(qp.get("emotion"));
  if (!SR && !isReal()) srUnavailable();
})();
