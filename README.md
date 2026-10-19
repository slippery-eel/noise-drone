# Noise & Drone

A browser-based generator for dark ambient beds and drones (film backgrounds, DAW samples), built on the Web Audio API. No dependencies, no build step.

## Usage

Open `index.html` in Chrome or Edge, or serve the folder (`python -m http.server`). **Space** plays and stops.

## Layers

Four stackable layers, each with its own **Level**, **Filter** (left of centre = low-pass, right = high-pass), **Pan** and **mute** (the dot on its tab). Muted layers aren't built, so they cost no CPU.

| Layer | Default | Sources |
|---|---|---|
| Bed | Pink noise, on | any |
| Tone | Tone (sine), muted | any |
| Air | White noise, high-passed, muted | any |
| Sub | Sine, muted | sine 1 or 2 octaves below the root |

Bed, Tone and Air can each play any source. A source's own controls only appear when that source is selected.

| Source | Controls | What it is |
|---|---|---|
| Noise | Colour (white / pink / brown) | Stereo noise, width-controlled decorrelation |
| Tone | Harmonics (1 = sine … 12), Octave | Additive 1/k series per voice |
| Organ | Bright, Breathe, Octave | 7 additive partials, each swelling on its own wander |
| Choir | Voice (Sung = 3-saw ensemble / Whisper = noise), Vowel (oo · ah · ee), Morph, Octave | Parallel F1/F2/F3 bandpasses; Morph lets a wander drift the vowel |
| Resonator | Colour, Inharm., Ring (Q 4–400), Octave | Noise exciting 6 high-Q bandpasses per voice, harmonic → free-bar (bowed metal) ratios |
| Hum | Mains (50 / 60 Hz), Buzz, Flutter | Mains hum with a strong 2nd harmonic, upper series and unsteady pitch/level. Ignores Pitch |

Voiced sources (Tone, Organ, sung Choir, Resonator) follow the global Pitch, Interval, Drift and Vibrato. Tone, Organ and sung Choir also take Beat.

## Global controls

| Group | Control | What it does |
|---|---|---|
| Sound | Volume | Output level (a protective limiter follows) |
| | Darkness | Master low-pass cutoff (shown in Hz). Sub bypasses it |
| | Resonance | Master low-pass Q |
| | Movement | Slow, non-repeating sweep of the cutoff (wander, in octaves) |
| | Width | Stereo width: noise decorrelation, or voice spread plus wandering pan |
| Pitch | Pitch | Root note (C1–C5) for voiced layers and the sub |
| | Interval | Voicing: unison, octave, fifth, tritone, minor 2nd, minor 9th |
| | Beat | Twin voice 0.2–4 Hz off pitch, for slow beating |
| | Drift | Each voice wanders off pitch independently (±50¢) |
| Character | Grit | Waveshaper distortion |
| | Age | Tape roll-off, saturation and hiss |
| | Wow | Wow & flutter: slow wandering tape speed (±4 ms) plus a fast 6 Hz shake |
| | Crackle | Sparse vinyl clicks (mostly faint, a few loud) and rare low pops |
| | Breath | Slow, uneven level swells |
| Space | Mix | Reverb level |
| | Size | Decay time (RT60), 0.8–12 s |
| | Damping | Highs die away faster than lows: a falling low-pass baked into the IR |
| | Pre-delay | 0–250 ms before the reverb starts |
| | Shimmer | Feeds the tail back an octave lower, so it keeps sinking |
| | Freeze | Hold the reverb tail indefinitely (**F** toggles) |
| Echo | Time | Tape delay, 50 ms–1.5 s. Changes glide like a tape speed change |
| | Feedback | Repeats. Each one passes a low-pass, a high-pass and a soft clip, so it's darker than the last |
| | Mix | Echo level. The echoes also feed the reverb |
| Events | Density | Average gap between one-shots, ~40 s down to ~3 s (random arrivals, never on a grid). Off by default |
| | Level | Event loudness |
| | Distance | Near = dry and bright · Far = low-passed, quieter and in its own room |
| | Variety | How far each event strays in pitch, length and loudness |
| | Types | Creak (stick-slip timber/hinge) · Thud (distant impact) · Swell (reversed, cut off) · Whisper (breathy formants, no words) · Ping (struck metal/pipe, tuned to Pitch) · Drip |
| | Pattern | **↻ New** picks another random pattern · **Fire now** (or **E**) fires one immediately, e.g. on a cut |
| Modulation | Shape | Sine (regular) or Wander (smooth random) |
| | Vibrato / Tremolo | Rate and depth |

The Pitch group hides when nothing pitched is playing. Double-click a slider to reset it. Shift-drag for fine control. **Space** plays and stops, **F** freezes, **E** fires an event.

**Events** are scheduled from a seeded random generator: live with a short lookahead, and up front for a render. The same settings and pattern give the same events every render. A render's events line up with what played after you pressed Play, as long as you didn't change Density, Types or the pattern while it was playing. Fire now uses separate randomness, so it never disturbs the pattern. Events join the chain after Darkness (Distance does that job for them), so they still get age, grit, tremolo, breath and the main reverb.

**Wander** modulation comes from long, seamlessly looping buffers of smooth fractal noise. It moves like an LFO that never audibly repeats, and it renders offline exactly as it plays live. Choir's vowel morph runs the wander through a WaveShaper curve per formant, so the vowel moves at audio rate too.

## Presets

Industrial · Ritual · Mechanical · Haunted · Deep Space · Room Tone · Unease · Glass · Red Room · Eraserhead · Abyss · Bowed Steel · Night Wind · Fluorescent · Séance · Submerged · Radio Ghost · Cathedral · Tinnitus · Pulse · Empty House · Cave. Each preset sets the full state, including all four layers, the space/echo/tape settings and events (Freeze is always off). Haunted, Industrial, Mechanical, Room Tone, Red Room, Eraserhead, Abyss, Night Wind, Séance, Submerged, Empty House and Cave come with events.

## Output

- **Capture**: records the live output, including slider moves, until you stop it. Stereo, 24-bit.
- **Render WAV**: offline render that uses the same audio graph as playback. 30 s – 5 min, 48 kHz / 24-bit / stereo. Optional seamless loop (tail crossfaded into head), fades, and normalise to −1 dBFS. The first 3 s are discarded, so the file starts "already playing". With Freeze on, a render captures its own freeze 4.5 s in and discards 9 s (long enough for every freeze loop to cycle), so the file is frozen from the first sample.

## Tech

Vanilla JS · Web Audio API · OfflineAudioContext · Canvas spectrogram

Noise is generated once into seamless-looping stereo buffers. The capture recorder is an AudioWorklet, falling back to a ScriptProcessor on `file://`, where Chrome blocks Blob-URL worklets.

One `buildGraph(ctx, state)` serves both the live `AudioContext` and the `OfflineAudioContext`. Inside it, each layer is source → high-pass → low-pass → panner → level. A layer is rebuilt only when a structural choice changes (source, colour, voice, interval, mute), with a short fade. Every other control is a parameter glide.

Space and tape, all inside `buildGraph`: layers → wow (short modulated delay) → tape → darkness → saturation → grit → tremolo → breath. That splits three ways: dry, the tape echo (delay → low-pass → high-pass → soft clip → feedback), and the reverb. The reverb is pre-delay → two convolvers. Changing Size or Damping generates a seeded IR (cached, so a render reuses it) into the idle convolver, which takes over the input while the old one rings out its own tail, so nothing clicks. Shimmer is a worklet-free octave-down shifter: two delay taps rising at 0.5 s/s with sin² crossfades, driven by one 4-channel looping buffer, fed back into the reverb. Freeze is four independent feedback loops (1.3–2.8 s) on the reverb output. Their feedback goes to 0.9995 while their input fades out, so each one holds a self-crossfaded stretch of the tail. They're deliberately not cross-coupled, because Chrome renders cross-coupled delay cycles unstably.
