// Emergency siren made with the Web Audio API only (oscillators, no audio
// files), so the strict Content-Security-Policy never blocks it.
//
// Sound: a sawtooth tone whose pitch is swept 650 -> 1250 Hz and back about
// once a second by a slow triangle "LFO" oscillator - the classic wail.
//
// Browsers keep audio locked until the user interacts with the page, so the
// AudioContext is created/resumed in unlock(), which must be called from a
// user gesture (pointer/key event). Everything is guarded: if Web Audio is
// missing or throws, the alarm pop-up simply works without sound.

export interface Siren {
  /** Web Audio exists in this browser */
  isSupported(): boolean;
  /** audio is allowed to play (AudioContext running) */
  isUnlocked(): boolean;
  /** create/resume the AudioContext - call from a user gesture. Resolves to isUnlocked(). */
  unlock(): Promise<boolean>;
  /** start the wail (no-op while locked or already playing) */
  start(): void;
  /** stop at once (no-op when silent) */
  stop(): void;
  /** notified when isUnlocked() may have changed */
  subscribe(listener: () => void): () => void;
}

export const SIREN_LOW_HZ = 650;
export const SIREN_HIGH_HZ = 1250;
export const SIREN_SWEEPS_PER_SECOND = 1;
export const SIREN_GAIN = 0.2;

type AudioContextCtor = new () => AudioContext;

/** The part of `window` the siren needs (older Safari only has webkitAudioContext). */
export interface AudioWindow {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
}

interface Playing {
  tone: OscillatorNode;
  lfo: OscillatorNode;
  depth: GainNode;
  out: GainNode;
}

function findAudioContext(win: AudioWindow | undefined): AudioContextCtor | null {
  return win?.AudioContext ?? win?.webkitAudioContext ?? null;
}

const browserWindow = (): AudioWindow | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as AudioWindow);

export function createWebAudioSiren(win: AudioWindow | undefined = browserWindow()): Siren {
  const Ctor = findAudioContext(win);
  let ctx: AudioContext | null = null;
  let playing: Playing | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const isUnlocked = () => ctx !== null && ctx.state === "running";

  function stop(): void {
    const nodes = playing;
    playing = null;
    if (!nodes || !ctx) return;
    try {
      const t = ctx.currentTime;
      // ~40 ms fade avoids a loud click; effectively immediate
      nodes.out.gain.cancelScheduledValues(t);
      nodes.out.gain.setValueAtTime(nodes.out.gain.value, t);
      nodes.out.gain.linearRampToValueAtTime(0, t + 0.04);
      nodes.tone.stop(t + 0.05);
      nodes.lfo.stop(t + 0.05);
      nodes.tone.onended = () => {
        for (const node of [nodes.tone, nodes.lfo, nodes.depth, nodes.out]) {
          try {
            node.disconnect();
          } catch {
            /* already disconnected */
          }
        }
      };
    } catch {
      // context closed or nodes already stopped - just drop them
      try {
        nodes.out.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  function start(): void {
    if (playing || !ctx || !isUnlocked()) return;
    try {
      const t = ctx.currentTime;
      const tone = ctx.createOscillator();
      tone.type = "sawtooth";
      tone.frequency.setValueAtTime((SIREN_LOW_HZ + SIREN_HIGH_HZ) / 2, t);

      // LFO adds +-300 Hz to the tone's frequency -> 650..1250 Hz sweep
      const lfo = ctx.createOscillator();
      lfo.type = "triangle";
      lfo.frequency.setValueAtTime(SIREN_SWEEPS_PER_SECOND, t);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime((SIREN_HIGH_HZ - SIREN_LOW_HZ) / 2, t);
      lfo.connect(depth);
      depth.connect(tone.frequency);

      const out = ctx.createGain();
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(SIREN_GAIN, t + 0.05);
      tone.connect(out);
      out.connect(ctx.destination);

      tone.start(t);
      lfo.start(t);
      playing = { tone, lfo, depth, out };
    } catch {
      playing = null; // Web Audio failed - the pop-up still works silently
    }
  }

  async function unlock(): Promise<boolean> {
    if (!Ctor) return false;
    try {
      if (!ctx) {
        // Without user activation the context would start suspended (and the
        // browser logs a warning); wait for a real gesture instead.
        if (typeof navigator !== "undefined" && navigator.userActivation?.isActive === false) return false;
        ctx = new Ctor();
        // e.g. iOS suspends audio on screen lock - re-evaluate when it changes
        ctx.addEventListener?.("statechange", notify);
      }
      // resume() must start inside the gesture handler: no await before it
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      /* still locked - try again on the next gesture */
    }
    notify();
    return isUnlocked();
  }

  return {
    isSupported: () => Ctor !== null,
    isUnlocked,
    unlock,
    start,
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The page-wide siren used by EmergencyAlarm (tests mock this module). */
export const siren: Siren = createWebAudioSiren();
