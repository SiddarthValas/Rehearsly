/* Microphone capture (16-bit mono WAV for faster-whisper) with live level metering and
   silence detection for hands-free answering, plus speech synthesis for the interviewer. */

function encodeWav(chunks: Float32Array[], inputRate: number, outputRate = 16000): Blob {
  // Downsample to 16 kHz: smaller uploads and exactly what Whisper wants.
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const ratio = inputRate / outputRate;
  const length = Math.floor(merged.length / ratio);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true);
  view.setUint32(28, outputRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += merged[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export type Recording = {
  stop: () => Promise<{ blob: Blob; duration: number; spoke: boolean }>;
  cancel: () => void;
};

export type RecordingOptions = {
  onLevel?: (level: number) => void; // 0..1, ~20 times a second
  autoStopAfterSilence?: number; // ms of silence after speech before auto stop (hands-free)
  onAutoStop?: () => void;
};

export async function startRecording(options: RecordingOptions = {}): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't record audio.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const chunks: Float32Array[] = [];
  const started = performance.now();
  let noiseFloor = 0.01;
  let spoke = false;
  let lastVoice = performance.now();
  let stopped = false;

  processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const elapsed = performance.now() - started;
    if (elapsed < 500) noiseFloor = Math.max(0.004, (noiseFloor + rms) / 2); // calibrate on the first half-second
    const voiced = rms > noiseFloor * 2.6 + 0.006;
    if (voiced) {
      spoke = true;
      lastVoice = performance.now();
    }
    options.onLevel?.(Math.min(1, rms * 9));
    if (options.autoStopAfterSilence && spoke && !stopped && performance.now() - lastVoice > options.autoStopAfterSilence) {
      stopped = true;
      options.onAutoStop?.();
    }
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  const teardown = async () => {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    if (context.state !== "closed") await context.close();
  };

  return {
    async stop() {
      stopped = true;
      await teardown();
      const duration = (performance.now() - started) / 1000;
      return { blob: encodeWav(chunks, context.sampleRate), duration, spoke };
    },
    cancel() {
      stopped = true;
      void teardown();
    },
  };
}

/* ---------------------------------------------------------------- speech output */

let cachedVoice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice;
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (!voices.length) return null;
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  // Neural voices first (Edge "Online (Natural)", Apple Premium/Enhanced, Chrome's Google voices), then classics.
  const neural = english.find((voice) => /natural|neural|premium|enhanced/i.test(voice.name) && !/compact/i.test(voice.name));
  const preferred = ["Ava", "Zoe", "Google UK English Female", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Samantha", "Daniel", "Karen", "Moira", "Rishi", "Veena"];
  cachedVoice =
    neural ??
    preferred.map((name) => english.find((voice) => voice.name.includes(name))).find(Boolean) ??
    english.find((voice) => voice.localService) ??
    english[0] ??
    null;
  return cachedVoice;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = undefined;
  };
}

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function stopSpeaking() {
  if (canSpeak()) window.speechSynthesis.cancel();
}

/** Speak text; resolves when finished (or immediately if speech isn't available). */
export function speak(text: string, onStart?: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (!canSpeak() || !text.trim()) return resolve();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    utterance.pitch = 1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      clearTimeout(guard);
      resolve();
    };
    utterance.onstart = () => onStart?.();
    utterance.onend = finish;
    utterance.onerror = finish;
    // Chrome pauses long utterances after ~15s unless nudged; also guard against a lost onend.
    const keepAlive = setInterval(() => {
      if (!window.speechSynthesis.speaking) return;
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 10000);
    const guard = setTimeout(finish, 2000 + text.split(" ").length * 600);
    window.speechSynthesis.speak(utterance);
  });
}

/* ---------------------------------------------------------------- natural voice (server TTS) */

export type VoiceChoice = "hannah" | "troy" | "austin" | "device";

export const VOICE_LABEL: Record<VoiceChoice, string> = {
  hannah: "Hannah",
  troy: "Troy",
  austin: "Austin",
  device: "Device voice",
};

let serverVoice = true; // flips off after a hard failure, so we stop retrying for this page load
let current: { cancelled: boolean } | null = null;
const cache = new Map<string, Promise<Blob>>();

export function setServerVoice(available: boolean) {
  serverVoice = available;
}

/* One shared <audio> element, unlocked during a user gesture. Safari and iOS only allow
   programmatic playback on an element that has already played inside a click or key press,
   so every later question plays through this same element. */
let player: HTMLAudioElement | null = null;
let unlocked = false;
let speechPrimed = false;
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

function getPlayer(): HTMLAudioElement {
  if (!player) {
    player = new Audio();
    player.preload = "auto";
    player.setAttribute("playsinline", "");
  }
  return player;
}

/** Call from click / keydown handlers. Cheap to call repeatedly. */
export function unlockAudio() {
  const audio = getPlayer();
  if (!unlocked && audio.paused) {
    audio.src = SILENCE;
    audio.play().then(() => { unlocked = true; }).catch(() => undefined);
  }
  if (!speechPrimed && canSpeak() && !window.speechSynthesis.speaking) {
    speechPrimed = true;
    // Safari also gates speechSynthesis behind a first gesture-initiated utterance.
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
  }
}

/** Fired when a browser still refuses to play; the UI shows a "tap to hear" button. */
export type BlockedHandler = (retry: () => void) => void;
let onBlocked: BlockedHandler | null = null;
export function setBlockedHandler(handler: BlockedHandler | null) {
  onBlocked = handler;
}

/** Split into sentence-sized pieces under the 200-character limit of the speech model. */
function chunks(text: string, limit = 175): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if ((buffer + sentence).length <= limit) {
      buffer += sentence;
      continue;
    }
    if (buffer) out.push(buffer.trim());
    if (sentence.length <= limit) {
      buffer = sentence;
    } else {
      // very long sentence: break at commas or spaces
      let rest = sentence;
      while (rest.length > limit) {
        const cut = Math.max(rest.lastIndexOf(", ", limit), rest.lastIndexOf(" ", limit));
        out.push(rest.slice(0, cut > 40 ? cut + 1 : limit).trim());
        rest = rest.slice(cut > 40 ? cut + 1 : limit);
      }
      buffer = rest;
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function fetchClip(text: string, voice: VoiceChoice, style: string): Promise<Blob> {
  const key = `${voice}|${style}|${text}`;
  if (!cache.has(key)) {
    const request = fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, style }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`speech ${response.status}`);
      return response.blob();
    });
    request.catch(() => cache.delete(key));
    cache.set(key, request);
    if (cache.size > 80) cache.delete(cache.keys().next().value as string);
  }
  return cache.get(key)!;
}

/* Loudness envelope computed from the clip itself (no audio routing, so nothing can mute
   playback). 50 values per second, read against audio.currentTime while it plays. */
async function envelope(blob: Blob): Promise<Float32Array | null> {
  try {
    const OfflineCtx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!OfflineCtx) return null;
    const decoder = new OfflineCtx(1, 1, 16000);
    const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(buffer.sampleRate / 50));
    const out = new Float32Array(Math.ceil(data.length / step));
    for (let i = 0; i < out.length; i += 1) {
      let sum = 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j += 1) sum += data[j] * data[j];
      out[i] = Math.min(1, Math.sqrt(sum / step) * 5);
    }
    return out;
  } catch {
    return null;
  }
}

function playBlob(blob: Blob, run: { cancelled: boolean }, onPlay: () => void, onLevel?: (level: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = getPlayer();
    const url = URL.createObjectURL(blob);
    let frame = 0;
    const levels = onLevel ? envelope(blob) : Promise.resolve(null);
    const cleanup = () => {
      cancelAnimationFrame(frame);
      onLevel?.(0);
      audio.onended = audio.onerror = audio.onplaying = audio.onpause = null;
      URL.revokeObjectURL(url);
    };
    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("playback"));
    };
    audio.onpause = () => {
      if (run.cancelled) {
        cleanup();
        resolve();
      }
    };
    audio.onplaying = () => {
      onPlay();
      void levels.then((env) => {
        if (!env || !onLevel) return;
        const tick = () => {
          onLevel(env[Math.min(env.length - 1, Math.floor(audio.currentTime * 50))] ?? 0);
          frame = requestAnimationFrame(tick);
        };
        tick();
      });
    };
    audio.src = url;
    audio.play().then(() => { unlocked = true; }).catch((error: Error) => {
      cleanup();
      reject(error);
    });
  });
}

/** Speak with the natural server voice, falling back to the device voice on any failure. */
export async function speakNatural(
  text: string,
  options: { voice: VoiceChoice; style?: string; onStart?: () => void; onLevel?: (level: number) => void },
): Promise<void> {
  stopAll();
  const { voice, style = "", onStart, onLevel } = options;
  if (voice === "device" || !serverVoice || !text.trim()) return speak(text, onStart);
  const run = { cancelled: false };
  current = run;
  const parts = chunks(text);
  const clips: (Promise<Blob> | null)[] = parts.map((part, i) => (i < 2 ? fetchClip(part, voice, style) : null));
  let started = false;
  const markStart = () => {
    if (!started) {
      started = true;
      onStart?.();
    }
  };
  for (let i = 0; i < parts.length; i += 1) {
    if (run.cancelled) return;
    let blob: Blob;
    try {
      blob = await (clips[i] ?? fetchClip(parts[i], voice, style));
      if (i + 2 < parts.length && !clips[i + 2]) clips[i + 2] = fetchClip(parts[i + 2], voice, style); // prefetch ahead
    } catch {
      if (!started) serverVoice = false; // e.g. rate-limited or not enabled on this key
      if (run.cancelled) return;
      return speak(parts.slice(i).join(" "), started ? undefined : onStart);
    }
    if (run.cancelled) return;
    try {
      await playBlob(blob, run, markStart, onLevel);
    } catch (error) {
      if (run.cancelled) return;
      if ((error as Error).name === "NotAllowedError" && onBlocked) {
        // The browser wants a tap first: hand the rest of the question to a "tap to hear" button.
        const rest = parts.slice(i).join(" ");
        onBlocked(() => {
          unlockAudio();
          void speakNatural(rest, options);
        });
        return;
      }
      return speak(parts.slice(i).join(" "), started ? undefined : onStart);
    }
  }
  if (current === run) current = null;
}

/** Stop any voice: natural clips and the device voice. */
export function stopAll() {
  if (current) {
    current.cancelled = true;
    current = null;
  }
  if (player && !player.paused) player.pause();
  stopSpeaking();
}

export const _chunksForTest = chunks;

/** Warm the cache for the first part of a line that will be spoken soon. */
export function prefetchVoice(text: string, voice: VoiceChoice, style = "") {
  if (voice === "device" || !serverVoice || !text.trim()) return;
  const first = chunks(text)[0];
  if (first) fetchClip(first, voice, style).catch(() => undefined);
}

/** Short sample so people can hear a voice before choosing it. */
export function previewVoice(voice: VoiceChoice, style: string, onLevel?: (level: number) => void) {
  return speakNatural("Hi, I'll be your interviewer today. Let's begin whenever you're ready.", { voice, style, onLevel });
}
