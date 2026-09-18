---
name: Atlas
description: "Clear way: focused personal learning, a yellow direction band, and a quiet humanist reader."
colors:
  bg: "#f5f6f8"
  bg-card: "#ffffff"
  bg-card-hover: "#edf0f5"
  bg-subtle: "#edf0f5"
  bg-elev: "#ffffff"
  fg: "#171d29"
  fg-muted: "#566273"
  fg-subtle: "#637187"
  border: "#d4dbe5"
  border-strong: "#758298"
  accent: "#765b0b"
  accent-surface: "#f6d94d"
  accent-ink: "#171d29"
  accent-hover: "#edce34"
  link: "#28568e"
  focus-ring: "#28568e"
  error: "#a62e43"
  error-surface: "#fff0f3"
  success: "#286847"
  success-surface: "#edf5f0"
  warning: "#765b0b"
  warning-surface: "#faf3dc"
  dark-bg: "#111722"
  dark-bg-card: "#1a2332"
  dark-bg-card-hover: "#242f40"
  dark-bg-subtle: "#202a3a"
  dark-bg-elev: "#1a2332"
  dark-fg: "#edf1f7"
  dark-fg-muted: "#bbc5d5"
  dark-fg-subtle: "#99a8bd"
  dark-border: "#374357"
  dark-border-strong: "#78879d"
  dark-accent: "#efd568"
  dark-accent-surface: "#dfc55b"
  dark-accent-ink: "#171d29"
  dark-accent-hover: "#ecd474"
  dark-link: "#b3cdf5"
  dark-focus-ring: "#b3cdf5"
  dark-error: "#ff9caa"
  dark-error-surface: "#39232e"
  dark-success: "#9cd4b5"
  dark-success-surface: "#1e3430"
  dark-warning: "#efd568"
  dark-warning-surface: "#342e1e"
typography:
  display:
    fontFamily: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 4.1vw, 3.6rem)"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 1.3rem + 2.8vw, 3.125rem)"
    fontWeight: 700
    lineHeight: 1.14
    letterSpacing: "-0.035em"
  title:
    fontFamily: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.4rem, 3vw, 1.7rem)"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  reading:
    fontFamily: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 1.05rem + 0.3vw, 1.25rem)"
    fontWeight: 400
    lineHeight: 1.8
  label:
    fontFamily: "'Trebuchet MS', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.5
  mono:
    fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace"
    fontSize: "0.85em"
    lineHeight: 1.65
rounded:
  learn-control: "3px"
  button: "4px"
  field: "6px"
  card: "8px"
  reader: "0.5rem"
  chip: "999px"
spacing:
  page-gutter: "clamp(18px, 3.5vw, 44px)"
  direction-inset: "clamp(1.5rem, 4.5vw, 3.5rem)"
  section: "clamp(2rem, 5vw, 3.5rem)"
  row: "1rem"
  collection-row: "1.5rem"
  control-gap: "0.65rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-surface}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.button}"
    padding: "0.6rem 1.2rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.button}"
    padding: "0.6rem 1.2rem"
  reader-primary:
    backgroundColor: "{colors.accent-surface}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.reader}"
    padding: "0.65rem 1.125rem"
  reader-secondary:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.reader}"
    padding: "0.65rem 1.125rem"
  learn-read-link:
    backgroundColor: "{colors.accent-ink}"
    textColor: "{colors.accent-surface}"
    padding: "0.8rem 1.15rem"
  learn-button:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.learn-control}"
    padding: "0.6rem 0.95rem"
  reader-input:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.reader}"
    padding: "0.875rem 1rem"
    width: "100%"
  nav-link:
    textColor: "{colors.fg-muted}"
    padding: "0.5rem 0"
  topic-chip:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.chip}"
    padding: "0.33rem 0.62rem"
  reader-callout:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.fg}"
    rounded: "{rounded.reader}"
    padding: "1rem 1.125rem"
  reader-disclosure:
    textColor: "{colors.fg}"
    padding: "1rem 0"
  collection-error:
    backgroundColor: "{colors.bg-card}"
    padding: "1rem 1.2rem"
---

# Design System: Atlas

## Overview

**Creative North Star: "Clear way"**

Atlas is focused personal learning: a clear next reading choice, strong humanist headings, and supporting information that stays quiet. Cool neutral surfaces and a yellow direction band carry the approved balanced composition; the lesson itself remains comfortable and unhurried.

Controls are flat and functional. Borders, spacing, and typography establish hierarchy rather than decorative depth. Both themes belong to the same world. The approved anti-references are a newsroom composition and the separate 3D experiments, not useful topic relationships or real work context.

**Key Characteristics:**
- Yellow direction, cool neutral surroundings.
- Humanist headings and a quiet, generous reader.
- Flat controls, ruled retrieval lists, and explicit states.
- Consistent light and dark themes with phone-first reading.

This records the built system, not a new concept. Source authority is `src\styles.css`, with the page-specific cascade in `src\pages\LearnHome.css`, `src\pages\LessonReader.css`, and `src\pages\LessonsList.css`; `index.html` carries the opening visual contract. `PRODUCT.md` owns product truth. The extension record is `.impeccable\design.json` (schema version 2). No synthetic color ramps or unimplemented tokens are added.

## Colors

Yellow supplies direction; cool paper, slate, and ink supply the working and reading surfaces.

### Primary

**Direction yellow** (`accent-surface`) is the lead lesson band, primary action fill, selected save state, brand mark, and text-selection background. **Accent ink** (`accent-ink`) stays dark in both themes for text on yellow and the inverted reading CTA. **Accent** is a separate, theme-adjusted foreground for emphasis, active navigation rules, and warnings; do not substitute yellow fill for text. `accent-hover` is the shared primary button's hover fill.

### Neutral

**Cool paper / night slate** (`bg`) frames **white / slate surfaces** (`bg-card`, also `bg-elev`). `bg-card-hover` provides interaction feedback; `bg-subtle` supports quiet controls. **Reading ink / pale ink** (`fg`) carries content; `fg-muted` is explanatory text and metadata; `fg-subtle` is tertiary text and placeholders. `border` divides content; `border-strong` delineates recovery notices and reader fields.

### Interaction and semantic states

**Link blue** (`link`) identifies links; `focus-ring` uses the same theme values but remains a separate role. Error rose, success green, and warning ochre each have a matching soft surface. These are status colors, not additional brand accents. Reader errors use error-colored text without a tinted panel; shared form messages and quota badges can use the semantic surfaces.

Unsuffixed frontmatter colors describe light mode; `dark-` entries describe the same CSS roles in dark mode. Component token references show the light mapping; runtime components and sidecar snippets use the active CSS variables. The CSS default is dark, while `index.html` applies the saved or system preference before render.

**The Role Pairing Rule.** Keep accent ink on accent surfaces, body text on neutral surfaces, and semantic text paired with its own state surface; switch complete theme roles rather than isolated colors.

## Typography

**Display and body font:** Trebuchet MS, then Segoe UI, UI sans-serif, system UI, and sans-serif. **Code font:** SF Mono, JetBrains Mono, Menlo, Consolas, and monospace. These are fallback stacks, not a requirement to fetch webfonts. The legacy `--font-serif` aliases `--font-reading`, which aliases `--font-sans`: this is a humanist sans-serif world, not a serif reader.

The frontmatter records observed roles, not an invented modular scale. Display is the lead lesson title; headline is the reader title; title is a Learn section heading; label is shared lesson metadata. Lead titles balance across a maximum of 22ch, reader titles across 25ch. Collections use a heading clamp of `clamp(2rem, 5vw, 3.2rem)` and row titles of `clamp(1.15rem, 2.5vw, 1.45rem)`.

Reading text uses the `reading` role and a maximum measure of 68ch. At the current root size its fluid range is 18px to 20px, with line boxes of 32.4px to 36px; the reviewed phone and desktop renders reach those endpoints. Paragraphs have a bottom margin of 1.3em. Reader subheadings use weight 700 and line-height 1.3; h2/h3/h4 sizes are 1.4em/1.175em/1em with margins of `2em 0 0.7em`. Code blocks use the mono role with horizontal overflow rather than shrinking prose.

**The Quiet Reader Rule.** Keep readable body type and its measure intact; separate metadata, questions, feedback, and provenance from the main lesson rather than making them compete with it.

## Layout

The shell centers a maximum 1180px content area with the fluid `page-gutter` on each side; its outer maximum is `calc(var(--content-width) + 2 * var(--page-gutter))`. Shell bottom padding is 4rem. Main content starts 2rem below navigation, reduced to 1.25rem at 600px and below. Learn has no extra top padding. Saved and History use a 960px maximum collection width; the centered reader is 100% wide up to 68ch, with 3rem bottom padding.

The sticky top bar places brand/repository, navigation, and account controls in three columns. At 1000px and below it becomes brand/account above a full-width navigation row. At 600px and below, the groups wrap according to available space; the repository control keeps a usable minimum instead of shrinking to its arrow. Learn, Topics, Saved, and History remain visible in content-sized links that can wrap into another row when text is enlarged. Repository and account labels truncate within their controls; lesson content wraps.

The lead band places lesson content beside the reading CTA, with relevance spanning the row below. Its columns collapse at 900px; the CTA becomes full width at 600px. Context and review/queued rows stack at 700px. At 380px, the band inset becomes 1.3rem and its title 1.85rem. Section spacing uses the fluid `section` value; ordinary rows are separated by rules rather than repeated raised tiles.

Reader header and completion actions wrap; at 480px they make the completion action and form submit buttons full width, place the completion hint on its own row, and stack disclosure hints. Collection error notices stack at 500px; collection row padding becomes `1.25rem 0`. Topic list rows stack at 600px, and lesson-title buttons wrap in both list and graph details. The optional flat topic graph places details alongside at 880px and above, below at 879px and below; its own viewport scrolls horizontally without widening the page.

## Elevation & Depth

The main experience is flat: the yellow band, lesson lists, reader, callouts, and controls have no decorative shadows. Surface tone and one-pixel rules separate regions. The account popover is the structural exception, using `0 10px 28px rgb(10 20 35 / 16%)` with a strong border. It sits at z-index 100, above the sticky top bar at 10; the focused skip link sits at 200. Do not turn that overlay treatment into a card style.

Motion is brief state feedback, not a source of depth. Learn controls transition opacity or background over 120ms ease; shared cards transition background and border color over 0.15s. Reader controls and related arrows explicitly have no transitions or positional movement. The global reduced-motion rule disables animations and transitions, including pseudo-elements, and restores automatic scrolling. Topic graph stroke-width changes are SVG paint feedback, not layout motion, and are disabled by that same rule.

## Shapes

The direction band and its inverted CTA are square-edged. Small control corners remain modest: Learn recovery controls use `learn-control`; shared buttons use `button`; fields and compact theme/language controls use `field`. Reader buttons, source panels, code blocks, and callouts use `reader`; shared cards use `card`. Topic chips and queued badges use the pill silhouette (`chip`), not primary actions. The graph container's existing 12px corners are local to that component, not a replacement global radius.

Solid one-pixel borders and horizontal rules provide structure. Reader quotations use a two-pixel left rule. Existing topic links use dashed underlines; unavailable or queued references use muted dotted underlines. Preserve those distinctions without treating suggested relationships as verified prerequisites.

## Components

### Buttons and primary actions

Flat, legible, and unmistakably actionable. Shared primary buttons use yellow fill, accent ink, `button` corners, and the frontmatter padding; hover uses `accent-hover`. Shared secondary buttons are transparent with a strong border, changing the border to muted foreground on hover.

The signature reading CTA in the yellow band inverts that pair, uses weight 700 and line-height 1.3, and has a 52px minimum height and a 15rem preferred minimum width capped by available space. The phone override fills its container, reduces inline padding to 0.75rem, and allows the label to wrap at enlarged text sizes. Hover changes opacity to 0.86; focus is an accent-ink outline on the yellow band, not the ordinary blue ring.

Reader primary, secondary, and feedback controls use 0.9375rem type, weight 600, line-height 1.4, and a 44px minimum height. The completion action is at least 48px high with a 10rem preferred minimum width capped by its container. Reader primary hover keeps the yellow fill and changes its border to accent ink; secondary hover changes to the card-hover surface. A saved lesson uses yellow fill and accent ink. Disabled reader buttons use opacity 0.65 and a not-allowed cursor. Learn recovery buttons retain their transparent surface, change background on hover, and use muted text when disabled.

### Navigation and retrieval

Primary navigation is Learn / Topics / Saved / History. Links use 0.95rem type, a 44px minimum height, and a two-pixel bottom border; default text is muted, while active/hover text is foreground with an accent rule. Active text is weight 700. The phone size is 0.875rem. Keep repository selection, account, language, and theme access available.

Learn and collection rows are linked, ruled entries with wrapped metadata, work-context text, and a quiet arrow. Hover underlines the title in link blue. Topics retain flat list/graph controls and pill-shaped filters; selected or hovered topic chips change text to foreground and border to accent. Queued content remains visibly distinct from ready lesson links.

### Cards, callouts, and disclosures

Shared cards use a neutral surface, one-pixel border, `card` corners, and 1rem padding; hover changes the surface and border rather than lifting the card. Do not replace the built ruled lesson collections with these cards.

Reader callouts are neutral panels with `reader` corners and the recorded padding. Their title is sentence-case, 1rem, weight 700; warning and remember titles use accent foreground, but their reader panel remains neutral. The older shared warning-callout surface does not override the reader-specific cascade.

Sources, contextual questions, and feedback use native disclosures with a top rule. Summaries have a 56px minimum height, 1rem vertical padding, weight 600, an outside marker, and a muted hint; hover changes summary text to link blue. Expanded content has `0.25rem 0 1.5rem` padding. Disclosure does not promote optional material above the lesson.

### Fields, focus, and recovery

Reader textareas have a visible label, neutral card surface, strong border, `reader` corners, 1rem type at line-height 1.6, and a 6rem minimum height. They resize vertically. Placeholders use subtle foreground at full opacity. Focus changes the border and applies a three-pixel focus outline with a three-pixel offset.

Keyboard focus is a three-pixel theme focus outline, normally offset by three pixels; Learn and collection links/buttons use four pixels. The yellow band overrides the focus color to accent ink. Retain the visible-on-focus skip link. General buttons and selects have a 44px minimum height; inline lesson topic references remain inline, not oversized buttons.

Collection and Learn failures use a neutral, strongly bordered recovery notice and explicit error-colored detail; reader action/form errors are unboxed error text near the affected action. Learn retry labels remain unbroken while message text yields space; recovery controls stack on narrow screens. Empty and loading states remain distinct from failures. Do not show a successful read, generation, or quota state before the corresponding current-context result; asynchronous completion, topic-context generation, and quota expiry are behavior constraints, not new visual states to invent.

## Do's and Don'ts

### Do:
- Do preserve the approved yellow direction band, cool neutral palette, humanist type, and quiet reader in both themes.
- Do keep Learn, Topics, Saved, and History visible and use real lesson, relevance, and source-context data.
- Do preserve the reader's 68ch maximum measure, fluid reading size, and 1.8 line-height.
- Do retain explicit pending, empty, error, disabled, and saved states, keyboard focus, and reduced-motion behavior.
- Do describe intro/intermediate/deep as reading coverage and topic relationships as suggestions.

### Don't:
- Don't introduce a serif reading world, decorative 3D, or a newsroom composition.
- Don't copy example lesson content from the approved composition into production or invent mastery scores.
- Don't present queued lessons as ready, browser-local review state as assessed mastery, or lesson publication as verified software deployment.
- Don't turn optional reader disclosures into competing primary panels or apply the popover shadow to ordinary content.
- Don't invent palette ramps, replacement tokens, or success feedback to conceal missing data or failed operations.
