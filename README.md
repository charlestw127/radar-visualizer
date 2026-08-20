# Radar Emission Visualizer

A small, dependency-free browser app that animates radar pulses travelling from an **emitter** to a **sensor**. Sliders control the carrier frequency, pulse repetition interval (PRI), pulse width and playback speed; two animation styles show the same pulse train in different ways.

## Running

No build step. Serve the folder with any static server (ES modules don't load from `file://`):

```bash
npm start                 # uses npx serve on http://localhost:5173
# or
python -m http.server 5173
```

Then open <http://localhost:5173>.

## Controls

All sliders are logarithmic, covering the spans an EW/ESM receiver actually sees:

| Control | Range | What it does |
|---|---|---|
| Carrier frequency | 100 MHz – 10 GHz (VHF → X band) | Density of the sine cycles / ring stripes inside each pulse |
| PRI | 1 µs – 10 ms (PRF 1 MHz → 100 Hz) | Time between successive pulses |
| Pulse width | 50 ns – 1 ms | Duration of each pulse → its physical length in flight |
| Emitter–sensor range | 1 – 300 km | Distance the pulse has to cover |
| Playback speed | 1 – 10 000 µs/s | Simulated microseconds per real second (×10⁶ … ×100 slow-motion) |

Pulse width is automatically capped at 90 % of the PRI so the duty cycle stays below 100 %.

Derived readouts update live: PRF, duty cycle, IEEE band letter, wavelength, pulse length, unambiguous range, range transit time, slow-motion factor. Keyboard: `Space` pause, `1` / `2` switch style, `R` reset.

A few combinations worth trying:

- **Long-range search radar** – 1.3 GHz (L), PRI 3 ms, PW 100 µs, 250 km, playback 1000 µs/s.
- **Fire-control / tracking** – 9.5 GHz (X), PRI 100 µs, PW 0.5 µs, 20 km, playback 50 µs/s.
- **High-PRF pulse-Doppler** – 10 GHz, PRI 5 µs, PW 1 µs, 10 km, playback 10 µs/s — watch several pulses stack up in flight at once.

URL parameters: `?style=wave|ring` picks the initial style; `?t=250` fast-forwards the simulation 250 µs on load (useful for screenshots).

### Animation styles

- **Sine wave** – each pulse is a burst of sine cycles moving along the straight line from emitter to sensor. The burst length is the pulse width; cycle spacing is the wavelength. The pulse is absorbed when it reaches the sensor.
- **Ring pulses** – each pulse is an expanding annulus centred on the emitter. Outer radius = leading edge, inner radius = trailing edge, so ring thickness is the pulse width. Concentric stripes mark the wavelength. When the ring sweeps across the sensor it lights up and a hit burst plays.

Both styles share the same simulation, so switching styles mid-flight keeps every pulse where it was.

A strip along the bottom plots the transmitted pulse train against time (right edge = now), which makes PRI, pulse width and duty cycle easy to read.

## What is to scale and what is not

The *timing* is physically exact: time is in microseconds, distance in *light-microseconds* (1 light-µs ≈ 300 m) so propagation speed is exactly 1 unit/µs, and pulse position, pulse length, PRI spacing, transit time and every readout follow from that. Three things are deliberately stylised because real values are sub-pixel at tens of km per canvas:

| Quantity | Real value | On screen |
|---|---|---|
| Carrier wavelength | 3 m at 100 MHz → 3 cm at 10 GHz | Cycle spacing is a log mapping of frequency: 48 px at 100 MHz down to 6 px at 10 GHz (`carrierSpacingPx`). Higher frequency still reads as "tighter cycles". |
| Pulse length | 15 m for a 50 ns pulse | Drawn at true length (pulse width × c) but never shorter/thinner than 10 px (`MIN_PULSE_PX`) so it remains visible. At 300 km range the true length of anything under ~4 µs is below that floor. |
| Hit / flash effects | a few µs | Timed in simulated µs, but held for at least ~0.1–0.35 s of wall-clock time so they stay perceptible at fast playback. |

The readouts always show the true physical values, so the panel is the reference if the picture is ambiguous.

## Architecture

```
index.html            Page shell: canvas + control panel
styles.css            Dark theme, layout
src/
  main.js             Entry point. Wires everything, runs the rAF loop
  params.js           Parameter model (PARAM_SPECS, Params class, derived values)
  simulation.js       Pulse-train state machine: emits/prunes pulses, hit detection
  scene.js            Canvas layout: emitter/sensor positions, px ↔ light-µs mapping
  controls.js         Builds the slider panel from PARAM_SPECS, syncs with Params
  renderers/
    common.js         Shared drawing: grid, emitter, sensor glow, hit burst, TX strip
    wave.js           Style 1 – sine bursts along the beam line
    ring.js           Style 2 – expanding annuli with wavelength stripes
```

### Data flow

```
 sliders ──▶ Params ──subscribe──▶ controls (readouts / clamping)
                │
                └──▶ Simulation.step(dt)  ──▶  pulses[]  ──▶  renderer.render(ctx, layout, sim)
                          ▲                                          │
                          │ timeScale, pri, pulseWidth, frequency     └── sensorIntensity() → hit FX
                          └── rAF loop (main.js)
```

**Params** is the single source of truth for slider values. It clamps to `PARAM_SPECS`, enforces the pulse-width-vs-PRI constraint, and notifies subscribers.

**Simulation** owns simulated time and the list of in-flight pulses. Each pulse *snapshots* the waveform parameters at emission, so moving a slider only affects new pulses — pulses already in the air keep their shape, which makes the effect of each slider obvious. Changing PRI reschedules the next emission relative to the last one rather than restarting the train. `sensorIntensity(distance)` returns 0–1 illumination and registers hit events. A separate `history` list of recent emissions feeds the TX strip, so bars persist after the pulse itself has been culled.

**Renderers** are pure functions `render(ctx, layout, sim)`. They read from the simulation but never mutate pulses (the only thing they set is `sim.maxRange`, the cull distance appropriate for their view). Adding a third style means adding one file under `src/renderers/` and one entry in the `RENDERERS` map in `main.js`.

**Layout** (`scene.js`) maps light-µs to pixels via `pxPerUs = distancePx / rangeUs`, recomputed every frame so both window resizes and the range slider keep the scene proportional.

**Controls** build each slider from `PARAM_SPECS`; `scale: 'log'` specs get a 0–1000 integer slider mapped exponentially onto `[min, max]`, so `Params` always holds real units and the DOM never does.

## Extending

- **New parameter** – add an entry to `PARAM_SPECS` in `params.js`; a slider appears automatically. Snapshot it onto pulses in `Simulation.step` if it should be per-pulse.
- **New style** – create `src/renderers/<name>.js` exporting `render(ctx, layout, sim)` and register it in `main.js` + `index.html`.
- **Received-signal trace, multiple sensors, Doppler** – all fit inside `Simulation` without touching renderers.
