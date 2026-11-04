# Artwork-driven visual pass

These screenshots use a synthetic track, colorful generated SVG artwork and deterministic audio features in Chromium, not live pl8list playback. They demonstrate desktop (1440×1000), mobile (390×844), short mobile (390×667), settings and login styling.

Validated: Bun frozen-lockfile installation, TypeScript check, production build, local font loading, WebGL shader creation/rendering, opening and dismissing settings, and a sustained synthetic drop whose one-shot envelope decays without retriggering. Chromium reported no page errors.

Still requires real-device validation: real-track onset timing, touch gestures, GPU context restoration, reduced-motion transitions, audio fallback on iOS, and comparative frame-time/battery measurements. Docker's Bun build stage was updated but the full container image was not built.

Run the frontend with `cd web && bun install --frozen-lockfile && bun run dev`. Build with `bun run build`.

The chromatic artwork material, artist accents and rounded controls have been restored following visual feedback. The drop button has a centered row beneath the waveform, no arrow, and a 44px minimum height. Chart selectors have dedicated clearance on short mobile screens.
