# Noise & Drone

A browser-based ambient sound generator built with the Web Audio API. No dependencies, no build step — open `index.html` and play.

## Modes

**Noise**
- **White** — full-spectrum random noise
- **Pink** — 1/f noise, warmer and more natural
- **Brown** — low-frequency heavy, deep rumble

**Drone**
- **Sine** — pure sustained tone
- **Pad** — layered detuned oscillators for a lush, evolving texture

## Controls

| Control | What it does |
|---|---|
| Volume | Output level |
| Texture | High-frequency filter cutoff |
| Darkness | Low-pass filter — rolls off the top end |
| Movement | LFO rate applied to the filter |
| Pitch | Base frequency for drone modes |
| Sub Bass | Adds a sub-octave sine underneath |
| Grit | Waveshaper distortion |
| Space | Reverb wet/dry mix |
| Drift | Random slow pitch drift over time |

## Presets

Industrial · Ritual · Mechanical · Haunted · Deep Space

## Actions

- **Make Darker** — pushes darkness and space up
- **Massive** — maxes volume and sub bass
- **Corrupt** — cranks grit and drift
- **Destabilize** — adds movement and drift randomness

## Export

Record 30 seconds or 1 minute of audio and download as a `.wav` file.

## Usage

Open `index.html` in any modern browser. No server required.

## Tech

Vanilla JS · Web Audio API · AudioWorklet · Canvas
