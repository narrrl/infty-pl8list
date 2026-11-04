# Artwork-driven visual pass

These screenshots use a synthetic track, colorful generated SVG artwork and deterministic audio features in Chromium, not live pl8list playback. They demonstrate desktop (1440×1000), mobile (390×844), short mobile (390×667), settings and login styling.

Validated: Bun frozen-lockfile installation, TypeScript check, production build, local font loading, WebGL shader creation/rendering, opening and dismissing settings, and a sustained synthetic drop whose one-shot envelope decays without retriggering. Chromium reported no page errors.

Still requires real-device validation: real-track onset timing, touch gestures, GPU context restoration, reduced-motion transitions, audio fallback on iOS, and comparative frame-time/battery measurements. Docker's Bun build stage was updated but the full container image was not built.

Run the frontend with `cd web && bun install --frozen-lockfile && bun run dev`. Build with `bun run build`.

The chromatic artwork material, artist accents and rounded controls have been restored following visual feedback. The drop button has a centered row beneath the waveform, no arrow, and a 44px minimum height. Chart selectors have dedicated clearance on short mobile screens.

The player now uses one waveform-aligned action console on desktop and mobile, with drop centered. A track without detected drops keeps that control disabled to preserve the layout. Primary controls use pl8list's public Pico lime colors (`#a5d601`, hover `#b2e51a`); artist colors still drive the artwork and waveform. Checked desktop and short-mobile layouts with chart selectors visible; the synthetic Chromium fixture reported no page errors.

Control-row refinement: removed the enclosing panel, aligned icons with their labels/counts, and replaced the solid drop fill with a subdued lime outline. The row retains 48px control heights. Updated desktop/mobile Chromium fixture screenshots; build and TypeScript checks pass.
