# ION Athens: DESIGN.md

Read this before you write any interface code. Values live in `tokens.css`; this file says what they mean and when they may be used. Marker legend: **(measured)** means computed with the WCAG 2 formula by `check/scripts/contrast.py` or checked in Chromium on 2026-11-21; **(unverified)** means still not measured or confirmed; **(suggestion)** means it is our own value, not a finding. Re-check (unverified) and (suggestion) before relying on them.

Stack and concept are not locked. Nothing here assumes one scene, route, character or framework. If your framework changes, `tokens.css` and the principles survive.

---

## 1. Point of view

1. ION Athens is built for people who cannot see the screen, so the accessibility constraints are the look: if a choice does not survive a blind user, a low-vision user and a projector at the back of a hall, it is not allowed.
2. The palette is black, white, and one yellow taken from the tactile paving strips on Athenian pavements: the colour of the line a cane already follows, now drawn on a screen.
3. Yellow always means path, route or warning, never decoration; that single rule is what stops "black and one accent" from reading as an AI default.
4. Type is heavy and condensed, Greek first, big enough that the spoken sentence is also readable from across a room; the screen shows what the voice says, word for word.
5. Everything is a hard edge: zero radius, thick borders, no soft shadows, no glow, because the product is about a surface you can trust under your feet.

The pitch lives in contrast and in one moment (section 5). Make the jury feel the route break and mend. Prefer a bold, legible, slightly severe poster over a polished app.

---

## 2. Colour

All tokens are in `tokens.css`. Every ratio below is (measured) with the WCAG 2 formula by `check/scripts/contrast.py`, to two decimals. `#FFD100` on `#000000` is 14.37:1; the WebAIM API shows 14.3 because it truncates, so the earlier "14.3" was the rounded WebAIM figure, not a different measurement. Re-check any new pair with `https://webaim.org/resources/contrastchecker/?fcolor=FFD100&bcolor=000000&api`. The yellow hex itself is still a placeholder (unverified): nobody has sampled a real Athenian paving strip.

| Token | Value | Role | Ratio on `--bg` |
|---|---|---|---|
| `--bg` | `#000000` | Every background. Pure black, never `#111` or `#0B0B0B`, no tint | n/a |
| `--fg` | `#FFFFFF` | Text, borders, icons | 21.00:1 |
| `--accent` | `#FFD100` (hex unverified: placeholder, sample a real paving strip from a photo) | The route, the path, focus, the one primary action, warning emphasis | 14.37:1 |
| `--on-accent` | `#000000` | Text on yellow blocks | 14.37:1 on accent |
| `--accent-dim` | `#B38F00` (suggestion) | Passed route, secondary route. Large text or non-text only | 6.85:1 |
| `--alert` | `#FF6B35` (suggestion) | Obstacle marker only, always inside a white ring | 7.41:1 |
| `--map-road` | `#3A3A3A` (suggestion) | Quiet base roads | 1.85:1 |
| `--map-label` | `#BDBDBD` (suggestion) | Map labels | 11.18:1 |
| `--map-building` | `#2A2A2A` (suggestion; `#333333` is the lightest allowed, 1.66:1) | Building extrusions. Never text. Projector legibility (unverified): test on the real projector | 1.46:1 |

Under `prefers-contrast: more`, `tokens.css` swaps `--map-road` to `#6A6A6A` (3.88:1), `--map-building` to `#5C5C5C` (3.14:1) and `--accent-dim` to `--accent`. The earlier `#4A4A4A` building measured 2.37:1 and failed the 3:1 non-text level, so it was replaced. In that mode `--accent` on `--map-road` falls from 7.78:1 to 3.70:1 (non-text only, so the route may never carry text) and `--accent` on `--map-building` is 4.58:1.

**Pairs that may be used together**

- `--fg` on `--bg`: body text, any size.
- `--accent` on `--bg`: route, headings, borders, icons, primary text.
- `--on-accent` on `--accent`: labels inside yellow blocks.
- `--alert` on `--bg`: obstacle marker and its label, always with icon and shape.
- `--accent` on `--map-road`: the route over a road, 7.78:1. Under `prefers-contrast: more` it is 3.70:1, non-text only.
- `--map-label` on `--bg`: map text, 11.18:1. On `--map-road` it is 6.05:1 (passes 4.5, not 7) and under `prefers-contrast: more` it falls below 4.5, so draw labels on a `--bg` plate, never straight on a road.
- `--fg` on `--map-building`: text over buildings, 14.35:1 at `#2A2A2A`, 12.63:1 at `#333333`.
- `--accent-dim` on `--bg`: 6.85:1. Passes 4.5 and 3, fails 7, so it is for non-text or large text and never for body copy. On `--map-road` it is 3.71:1, non-text only.
- `--alert` on `--map-road`: 4.01:1, non-text only. Under `prefers-contrast: more` it falls to 1.91:1, so the obstacle marker always carries a white `--fg` ring and a black glyph; it never relies on orange against the road.

**Pairs that may not be used**

- `--accent` next to `--alert` as the only difference: 1.94:1 apart. Always separate them by icon, shape and sound as well as hue.
- `--map-road` as text colour on `--bg` (1.85:1), `--map-building` as text colour on `--bg` (1.46:1 at `#2A2A2A`, 1.66:1 at `#333333`).
- `--fg` on `--accent` (1.46:1) for text, or as an outline that has to be read against the yellow itself.

Colour is never the only signal. Every state has a second carrier: an icon, a shape, a word, or a sound.

---

## 3. Type

**Families.** Display and instructions: Sofia Sans Condensed (variable). Body: Sofia Sans (variable). Self-hosted via fontsource (see AGENTS section). Both have a Greek subset. Do not swap the font: Atkinson Hyperlegible Next, Space Grotesk, Geist, Archivo and Unbounded have no Greek or were rejected. Sofia passed the glyph test (see Weights), so the fallbacks are only for a missing font file: Fira Sans Extra Condensed or Inter Tight (Greek reported by the scout, not re-verified, unverified).

**Packages (measured).** `@fontsource-variable/sofia-sans-condensed@5.3.0` and `@fontsource-variable/sofia-sans@5.3.0` both ship `*-greek-wght-normal.woff2` (15.7 KB and 15.6 KB), unicode-range U+0370-03FF. CSS family names are "Sofia Sans Condensed Variable" and "Sofia Sans Variable", the same as `tokens.css`. The weight axis runs 1 to 1000, so 1100 is clamped to 1000.

**Language.** Set `lang="el"` on `<html>` (switch to `en` when toggled). Greek accents drop correctly in uppercase only when `lang="el"` is set.

**Weights.** Instructions 850 to 1000 (default 950). Secondary 750. Body 700. Never below 700 with the condensed face. The Greek glyph test (`ΕΜΠΟΔΙΟ / Στρίψτε δεξιά / ΆΈΉΊΌΎΏ ΐΰ`) was run in Chromium (measured): 69 characters (Α-Ω, α-ω, ς, ά έ ή ί ό ύ ώ ϊ ϋ ΐ ΰ and capitals with tonos) in both families at weights 100 and 950, none fell back to another face, and the specimen renders it cleanly at 900 to 1000. Not yet checked: Android Chrome on the demo phone (unverified), and the projector.

**Scales (Greek text first, English is the translation, not the layout driver)**

| Role | Phone | Large screen | Weight |
|---|---|---|---|
| Instruction / caption | 4rem (range 3 to 5rem) | 8vw (range 6 to 10vw) | 950 |
| Secondary / status | 2rem (suggestion) | 3vw (suggestion) | 750 |
| Body, smallest allowed | 1.5rem (suggestion) | 2vw (suggestion) | 700 |

The phone numbers 2rem and 1.5rem and the stage numbers 3vw and 2vw are suggestions; the ranges for instruction and caption come from the scout.

**Caption fit at 8vw (measured on the specimen).** The condensed face at 950 averages about 0.41em per Greek character (the 31-character sentence below is 12.78em wide), so one line at 8vw holds about 29 characters in a 96vw text area. "Ο δρόμος μπροστά είναι κλειστός" (31 characters) breaks to two lines. Plan for two lines: the caption bar with its small label and two lines is 23.3vw tall (41% of a 16:9 stage, measured in the specimen), and the map is framed in the space above it, so the route and the obstacle never sit under the bar. At 6vw a line holds about 38 characters; use that only if a sentence must stay on one line. A one-line caption such as "Στρίψτε δεξιά σε 15 μέτρα." (10.33em) fits at 8vw with room to spare.

**Greek line height.** Tonos on capitals (Ά, Έ) and on lowercase letters sits above the x-height. Leading below 1.0 for titles, and 0.95 for the stage caption, let it touch the descenders of the line above, so titles use 1.0 or more and the stage caption uses 1.05 (`--t-lh-instruction`). Single-word alerts in capitals have no tonos, so they can be set tighter and get +0.015em tracking.

**Rules**
- Uppercase only for single-word alerts (`ΕΜΠΟΔΙΟ`). Never all-caps eyebrows or labels.
- One idea per line. A caption is the spoken sentence; do not paraphrase it.
- Text is live text. Never bake words into images or animations.
- Scale with `vw` on the stage and `rem` on the phone; never a fixed px that the projector will shrink.

---

## 4. Spacing, shape, borders, focus

All suggestions unless noted.

- **Base 8px.** Scale 8 / 16 / 24 / 48 / 96 (`--space-1` to `--space-5`). On the stage, use the `vw` overrides in `tokens.css`.
- **Radius 0.** No rounded cards, pills or circles for containers. A circle is allowed only for a map position dot, because it is a point, not a container.
- **Borders 4px** (`--border`, `--border-accent`). A border does the work a shadow would do. No soft shadows, no blur, no glow.
- **Touch targets at least 64px tall, full width on the phone.** One primary action per screen. Primary is a solid yellow block with black text; everything else is a white 4px outline on black.
- **No nested cards.** A panel is a bordered block; do not put a bordered block in a bordered block.
- **Focus.** A 6px outline, 4px offset, never removed. The ring is judged against the backdrop it lands on, not against the element it surrounds: a yellow ring around a black or white-outlined element on black (14.37:1), a white ring around a yellow button on black (21:1, it lands on the black gap, not on the yellow), and a black ring around anything on a yellow backdrop (14.37:1; white would be 1.46:1 and fail). Under `forced-colors` use the system `Highlight`. The specimen has a Focus section. Real Tab presses were driven in headless Chromium and checked by eye on a black button on a yellow backdrop (black ring) and on the yellow primary button on black (white ring); the yellow ring on a black element is shown pinned (class `.sf`), not from a real Tab. Still test by tabbing through every real screen on the demo device before showing it.
- **Layout.** Phone: one column, one instruction, one action. Stage: map fills the screen, caption bar across the bottom, status line top. No centred hero with three feature boxes. The "© OpenStreetMap" credit sits on its own white-bordered plate in a map corner, clear of the caption bar.
- **Compact scale on the game map.** `/play` uses the `--hud-*` tokens (48px targets, 18px HUD text, 44 to 56px map objects) because there the map is the content and the HUD floats over it; sheets, cards and every other screen keep the phone scale above. (suggestion, checked on the 360 px demo phone)
- **Two compositions, not a crop.** A surface that changes orientation gets its own map composition (landscape on the stage, portrait on the phone), not a zoomed or cropped copy of one drawing.
- **Tactile route.** The route is drawn as a yellow band with a row of black dots down its centre, like the pavement it comes from: hard-edged, no gradient. Dots are points, so they are allowed (radius rule).

---

## 5. Motion

Motion explains a change of state. It never decorates. Use `--ease-hard` (stepped) for markers appearing, and `--ease-settle` for the camera. All values are suggestions: tune by eye on the real projector.

**Baseline.** The route is a solid `--accent` line, the walker a `--fg` dot with a `--accent` ring. Idle motion is zero. Nothing pulses, floats or loops without a cause.

**The signature moment: the route changes.** Describe it as a pattern so any scene can use it. It has four beats and takes about 2.5 seconds (suggestion). Run it whenever a planned route becomes invalid because of something ahead.

1. **Warn (0 ms).** The earcon plays about 300 ms before anything moves (see section 6). The caption bar swaps to the obstacle sentence in `--alert` wording with the obstacle icon. The obstacle marker appears at its position with `--ease-hard`, in `--alert` with an icon and a hard-edged shape, 120 ms. A short white ring expands from it once.
2. **Cut (about 300 ms).** The part of the old route beyond the obstacle stops being yellow: it turns `--accent-dim` and becomes dashed, then is removed. The cut is a hard edge, not a fade. The part behind the walker stays solid.
3. **Mend (about 700 ms).** A new `--accent` line is drawn from the walker around the obstacle and rejoins the old route, drawn as a growing line over `--dur-draw`. Its first segment starts at the walker so the eye follows the line, not a jump.
4. **Say (synced).** The caption changes to the new instruction at the moment the speech `start` event fires, not before (the sync mechanism is not covered by any finding; see AGENTS section). The camera then eases over `--dur-camera` to frame the walker and the new path.

On the phone the same four beats happen without a map: full-screen `--alert` block with icon and word, then a `--accent` block with the new instruction. The audio does the work; the screen is the confirmation.

The jury should remember: yellow line, cut, new yellow line, a calm voice. Keep it a single clean take. A stuttering demo loses more than a plain one gains.

**Reduced motion.** With `prefers-reduced-motion: reduce` the four beats still happen as instant state swaps: no drawing, no camera ease, no ring. The information (obstacle, new route, caption) is identical. No flashing at any setting: nothing may change more than three times per second.

**Banned motion.** Page-load staggers, parallax, bouncing, glows, marquee text, looping decorative animation, motion that ignores `prefers-reduced-motion`.

---

## 6. Sound and vibration

Sound and vibration are part of the system, not an add-on. For the phone user they are the interface.

**Channels.** Speech carries the content. Earcons carry the category. Vibration carries urgency. Screen is the mirror. No state exists in only one channel, and haptics are never the only channel.

**Earcons.** Choose 4 to 5 neutral sounds from Kenney "Interface Sounds" (CC0, 100 files; file formats unverified). Suggested roles (suggestion): route start, instruction, obstacle, new route, arrival. Each role has one sound and keeps it. Every sound is short and not alarming.

**Order.** Earcon about 300 ms before the voice, then the obstacle warning before the turn, then one instruction in flight. Call `speechSynthesis.cancel()` before an urgent message. Rate about 1.1. These are the scouts' suggestions.

**One speech channel per message.** A React Aria live-region announcement must not overlap your own `speechSynthesis` output. Pick one path per message.

**Vibration.** At most 4 patterns (suggestion for names): `nudge` (instruction), `error` (obstacle), `success` (new route confirmed / arrival), plus one reserved. Use `web-haptics`; on Android it uses `navigator.vibrate`. On iOS it fires only inside a user tap, so the demo phone is Android + Chrome. Plain `navigator.vibrate([...])` is the fallback (suggestion). For the audience to feel it, the stage screen must trigger its own haptic call with `debug:true` or show a visible vibration indicator.

**Start from a tap.** Browsers block audio and speech before a user gesture. The first utterance starts from a tap on the big start button.

---

## 7. Spoken Greek

**Voice.** Formal plural throughout ("Στρίψτε", matching "Πλησιάζετε") (suggestion). Short, calm, no exclamation marks, no filler. Write units out in speech: "20 μέτρα", not "20 μ." (suggestion).

**Fixed shape: what, where, what to do** (suggestion). Example:

> Εμπόδιο σε 20 μέτρα: σκαλωσιά στο πεζοδρόμιο. Νέα διαδρομή: στρίψτε δεξιά σε 15 μέτρα.

The obstacle phrases are ours to write; Soundscape has none. Use proportional directions: "αριστερά / ευθεία / δεξιά", not clock-face. The Wayfindr / ITU-T F.921 basis for this is unverified: do not cite it to the jury until the PDF is read.

**Distance and timing rules (from Soundscape, confirmed)**
- Round distances to the nearest 5 m under 1 km and to 50 m above.
- Say "κοντά" (close by) at 15 m or less.
- GPS accuracy of ±10 m or better: say the plain distance. Up to ±20 m: say "about" ("περίπου"). Worse: say "around" ("γύρω στα").
- Recompute only after 5 m and 5 s of movement. Look at most 25 m ahead within a 60° cone.
- Never repeat the same intersection callout within 30 s.

**Reusing Soundscape strings.** Use `el-GR.lproj/Localizable.strings`, for example "Πλησιάζετε τη διασταύρωση" and "Στροφή δεξιά. Τώρα κατά μήκος της %@". Proofread: double spaces, and gender agreement (`της %@` assumes a feminine street name). Keep the licence note: Soundscape is MIT; no separate text licence was found for strings beyond that.

**Greek display.** The caption shows the exact spoken string. `lang="el"` on the caption element too if the page is bilingual. Proofread generated Greek for double spaces and for uppercase that keeps a tonos: with `lang="el"` the browser drops it (`Εμπόδιο` becomes `ΕΜΠΟΔΙΟ`).

---

## 8. Never

| Never | Reason |
|---|---|
| Purple gradients, glassmorphism, glows | Generic AI look; glow also lowers measured contrast |
| Rounded cards, pills, soft shadows | Wrong point of view; the system is hard-edged |
| Nested cards | Visual noise, reads as a template |
| Emoji as icons | Inconsistent, unreadable to screen readers; use Phosphor `fill`/`bold` plus one custom SVG |
| Centred hero with three feature boxes | The template look the brief rejects |
| Tinted near-black (`#111`, `#0B0B0B`) | Lowers contrast and reads as a default dark theme |
| Yellow as decoration | It must mean path, route or warning, or the meaning is lost |
| Colour as the only signal | Fails colour-blind and low-vision users, and a washed-out projector |
| Haptics as the only channel; more than 4 haptic patterns | Unprompted iOS haptics do not fire; patterns beyond 4 cannot be learned |
| Fonts without Greek, or swapping the pinned font | Missing glyphs fall back to a random face and break the look |
| Body text below 1.5rem on the phone or weight below 700 on the condensed face | Illegible for low-vision users |
| Uppercase eyebrows or long uppercase text | Hard to read; Greek accents misbehave without `lang="el"` |
| Text baked into images or animations | Not accessible, cannot be translated or read aloud |
| Stock shadcn or pastel neobrutalism visuals; stock Lottie illustrations | Generic look; dotLottie also fetches WASM from a CDN |
| `→` on buttons, middle-dot meta strings | Marked as AI-slop patterns by Impeccable and the frontend-design skill |
| Motion that ignores `prefers-reduced-motion`; flashing | Vestibular and seizure risk |
| Removing or softening the focus ring | Keyboard and switch users lose their place |
| Remote assets on demo day (CDN fonts, online tiles) | Venue network is a risk; self-host fonts, PMTiles, glyphs, sprites, sounds |
| Quoting Overpass counts, the Wayfindr/ITU basis, or an Athenian paving hex as fact | All unverified. The contrast ratios are measured and may be quoted |
| Dropping "© OpenStreetMap" from the map | ODbL requires it; it must stay visible |
| Vendoring APCA code | Its licence warning was not re-verified |

---

## 9. Checklist (run before showing any work)

1. Background is `#000000` everywhere; no tinted near-black.
2. Every text and colour pair is in the allowed list in section 2. Run `check/scripts/contrast.py` or the WebAIM API on any new pair. Also check it under `prefers-contrast: more`.
3. Yellow appears only as path, route, focus, the one primary action, or warning. Count the yellow elements; each has a meaning.
4. Every state has a second carrier besides colour: icon, shape, word or sound.
5. Greek renders: `lang="el"`, `ΕΜΠΟΔΙΟ / Στρίψτε δεξιά / ΆΈΉΊΌΎΏ ΐΰ` shows with no fallback glyphs at the weights used (passed in Chromium; repeat on the demo phone).
6. Phone: instruction 4rem/950, nothing below 1.5rem/700, targets at least 64px, one primary action.
7. Stage: caption about 8vw/950 (two lines max, bar height reserved, map framed above it), readable from the back of the room, no text smaller than 2vw (suggestion).
8. Radius 0, 4px borders, no shadows, no glow, no nested cards, no emoji icons.
9. Tab through every screen: the focus ring is visible on black and on yellow.
10. Turn on reduced motion: all information is still shown, nothing flashes.
11. Speech: the spoken line follows what, where, what to do; formal plural; units written out; distances rounded per section 7; one instruction in flight.
12. Caption equals the spoken string and appears when speech `start` fires.
13. Sound and vibration: earcon before voice; at most 4 haptic patterns; first audio starts from a tap.
14. Offline: fonts, tiles, glyphs, sprites and sounds are served locally. "© OpenStreetMap" is visible.
15. The map canvas has a text alternative (route as a list); axe excludes the canvas and passes `wcag2a`, `wcag2aa`, `wcag21aa`.
16. Never-list scan (section 8): nothing on it is present.
17. Squint test: blur the screenshot. The route, the obstacle and the instruction should still be the three loudest things. If not, remove something.
