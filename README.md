# Noise & Drone

Noise & Drone makes dark ambient beds and drones in a web browser. You can use the sound under film scenes or as samples in a DAW. The app uses the Web Audio API. It has no dependencies and no build step.

This README is written in ASD-STE100 Simplified Technical English.

## Requirements

- Use Chrome or Edge. Other browsers are not tested.
- Python 3 is optional. You need it only to serve the folder.

## Start the app

1. Open `index.html` in the browser.
2. Alternatively, serve the folder:

   ```bash
   python -m http.server 8000
   ```

   Then go to `http://localhost:8000`.
3. Push **Space** to start the sound.
4. Push **Space** again to stop the sound.

> **Note:** On `file://`, Chrome blocks the AudioWorklet. The capture recorder then uses a ScriptProcessor. The output is the same.

## Keyboard shortcuts

| Key | Function |
|---|---|
| Space | Start or stop the sound |
| F | Set Freeze on or off |
| E | Fire one event immediately |

## Slider controls

- Double-click a slider to set it to its default value.
- Hold Shift and drag a slider for fine adjustment.

## Layers

The app has four layers. You can use them together. Each layer has these controls:

- **Level**: the volume of the layer.
- **Filter**: left of centre is a low-pass filter. Right of centre is a high-pass filter.
- **Pan**: the left-right position.
- **Mute**: the dot on the layer tab. The app does not build a muted layer, so it uses no CPU.

| Layer | Default | Sources |
|---|---|---|
| Bed | Pink noise, on | All |
| Tone | Tone (sine), muted | All |
| Air | White noise with a high-pass filter, muted | All |
| Sub | Sine, muted | Sine, 1 or 2 octaves below the root note |

Bed, Tone and Air can use all sources. The app shows the controls of a source only when you select that source.

| Source | Controls | Description |
|---|---|---|
| Noise | Colour (white, pink, brown) | Stereo noise. Width sets the difference between the left and right channels. |
| Tone | Harmonics (1 = sine to 12), Octave | Additive harmonics at 1/k level for each voice. |
| Organ | Bright, Breathe, Octave | Seven additive partials. Each partial changes level slowly and independently. |
| Choir | Voice (Sung or Whisper), Vowel (oo, ah, ee), Morph, Octave | Three band-pass filters (F1, F2, F3) in parallel. Sung uses three saw waves. Whisper uses noise. Morph moves the vowel slowly. |
| Resonator | Colour, Inharm., Ring (Q 4 to 400), Octave | Noise goes into six narrow band-pass filters for each voice. Inharm. changes the ratios from harmonic to metal bar ratios. |
| Hum | Mains (50 Hz or 60 Hz), Buzz, Flutter | Mains hum with a strong second harmonic and an unstable pitch and level. Hum does not use Pitch. |

Tone, Organ, sung Choir and Resonator use the global Pitch, Interval, Drift and Vibrato controls. Tone, Organ and sung Choir also use Beat.

## Global controls

| Group | Control | Function |
|---|---|---|
| Sound | Volume | Sets the output level. A limiter protects the output. |
| | Darkness | Sets the cutoff of the main low-pass filter (in Hz). Sub does not go through this filter. |
| | Resonance | Sets the Q of the main low-pass filter. |
| | Movement | Moves the cutoff slowly. The movement does not repeat. |
| | Width | Sets the stereo width. |
| Pitch | Pitch | Sets the root note (C1 to C5) for the voiced layers and Sub. |
| | Interval | Sets the voicing: unison, octave, fifth, tritone, minor 2nd or minor 9th. |
| | Beat | Adds a second voice 0.2 Hz to 4 Hz off pitch. This makes a slow beat. |
| | Drift | Moves each voice off pitch independently, up to ±50 cents. |
| Character | Grit | Adds distortion. |
| | Age | Adds tape high-cut, saturation and hiss. |
| | Wow | Adds a slow tape speed change (±4 ms) and a fast 6 Hz flutter. |
| | Crackle | Adds vinyl clicks and some low pops. |
| | Breath | Adds slow, irregular level changes. |
| Space | Mix | Sets the reverb level. |
| | Size | Sets the decay time (RT60), 0.8 s to 12 s. |
| | Damping | Makes high frequencies decay faster than low frequencies. |
| | Pre-delay | Sets a delay of 0 ms to 250 ms before the reverb. |
| | Shimmer | Sends the reverb tail back one octave lower. |
| | Freeze | Holds the reverb tail for an unlimited time. |
| Echo | Time | Sets the tape delay time, 50 ms to 1.5 s. A change of time sounds like a change of tape speed. |
| | Feedback | Sets the number of repeats. Each repeat is darker than the previous repeat. |
| | Mix | Sets the echo level. The echoes also go into the reverb. |
| Events | Density | Sets the average time between events, approximately 40 s to 3 s. The default is off. |
| | Level | Sets the event level. |
| | Distance | Near is dry and bright. Far is darker, quieter and has its own reverb. |
| | Variety | Sets the range of pitch, length and level for each event. |
| | Types | Creak, Thud, Swell (reversed), Whisper (no words), Ping (tuned to Pitch), Drip. |
| | Pattern | **↻ New** selects a new random pattern. **Fire now** fires one event immediately. |
| Modulation | Shape | Sine (regular) or Wander (smooth and random). |
| | Vibrato, Tremolo | Rate and depth. |

The app hides the Pitch group when no voiced source plays.

### Events

A seeded random generator sets the time of each event. The same settings and the same pattern give the same events in each render. A render has the same events as the live sound if you do not change Density, Types or Pattern during playback. **Fire now** does not change the pattern.

### Wander modulation

Wander uses long buffers of smooth random noise. These buffers loop without a gap. The movement does not repeat audibly. The live sound and the render are the same.

## Presets

The app has 36 presets in six groups. Use the tabs above the preset buttons to select a group. The browser keeps the last group that you opened.

| Group | Presets |
|---|---|
| Places | Room Tone, Empty House, Cave, Cathedral, Fluorescent, Motel Room, Stairwell |
| Voices | Haunted, Séance, Red Room, Radio Ghost, Ritual, Lullaby, Possession |
| Machines | Industrial, Mechanical, Eraserhead, Pulse, Generator Room, Ventilation |
| Metal & Glass | Glass, Bowed Steel, Tinnitus, Frost, Shipwreck |
| Vast & Deep | Deep Space, Abyss, Unease, Submerged, Void |
| Open Air | Hillside, Mountain Path, Thin Air, Summit Hymn, Night Wind, Storm Front |

Use the Open Air presets under dialogue. They are quieter and have fewer high frequencies. They have no near events and no whisper events.

A preset sets all controls. Freeze is always off after you select a preset. The groups and names are in `PRESET_GROUPS` and `PRESET_LABELS` in `app.js`.

## Output

### Capture

1. Push **⏺ Capture** to start the recording.
2. Change the controls if necessary. The recording includes the changes.
3. Push the button again to stop the recording.

The file is stereo, 24-bit WAV.

### Render WAV

**↓ Render WAV** makes an offline render. It uses the same audio graph as the live sound.

| Property | Value |
|---|---|
| Length | 30 s to 5 min |
| Format | 48 kHz, 24-bit, stereo WAV |
| Options | Seamless loop, fade in and fade out, normalise to −1 dBFS |

- The render removes the first 3 s. Thus the file starts with the sound already in progress.
- With Freeze on, the render removes the first 9 s. Thus the file is frozen from the first sample.
- **Seamless loop**: the render crossfades 4 s of the tail into the head. The gain of the crossfade changes for each short block. This keeps the level constant for noise and for tonal sounds. The last sample goes smoothly into the first sample.

## Technical description

- Vanilla JavaScript, Web Audio API, OfflineAudioContext, Canvas spectrogram.
- The app makes the noise one time, into stereo buffers that loop without a gap.
- One function, `buildGraph(ctx, state)`, builds the graph for the live `AudioContext` and for the `OfflineAudioContext`.
- Each layer is: source → high-pass → low-pass → panner → level.
- The app builds a layer again only when you change source, colour, voice, interval or mute. A short fade prevents clicks. All other controls change parameters smoothly.

### Signal chain

1. Layers → wow (short modulated delay) → tape → darkness → saturation → grit → tremolo → breath.
2. The signal then goes to three paths: dry, tape echo and reverb.
3. Tape echo: delay → low-pass → high-pass → soft clip → feedback.
4. Reverb: pre-delay → two convolvers. When you change Size or Damping, the app makes a new seeded impulse response in the idle convolver. The old convolver continues until its tail stops. This prevents clicks.
5. Shimmer: two delay taps with sin² crossfades shift the tail one octave down. The result goes back into the reverb.
6. Freeze: four independent feedback loops (1.3 s to 2.8 s) on the reverb output. Their feedback increases to 0.9995 while their input decreases to zero.

> **Caution:** Do not cross-couple the delay loops. Chrome renders cross-coupled delay loops unstably, and the level increases without limit.

## Files

| File | Contents |
|---|---|
| `index.html` | Page structure and controls |
| `style.css` | Styles |
| `app.js` | Audio graph, controls, presets, render and WAV encoder |
