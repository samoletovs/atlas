# Atlas

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Atlas serves a working professional learning from AI-assisted delivery work, initially Sam. Reading often happens in short sessions on a phone away from the development environment. The implemented application also distinguishes repository owners and members.

## Product Purpose

Close the gap between what the user delivers and what they understand about it. Offer useful, phone-readable lessons connected to their work, then help them revisit or explore related material.

## Positioning

Learning is connected to the user's actual project context rather than a generic course catalogue, news feed, documentation archive or agent-management console.

## Operating Context

The primary journey is to choose a useful lesson, understand its connection to work, read it, ask a contextual question if needed, and mark it read, save it or choose a related lesson.

The approved redesign consolidates Next up and For you into Learn, with Topics, Saved and History as clear retrieval destinations. Existing repository selection, language, theme, account controls and permissions remain available.

## Capabilities and Constraints

- Existing information includes lesson title, topic, depth, reading time, Markdown body, citations, suggested next topics, source-event context, read/save state, rating/comments and recommendation reasons.
- Intro/intermediate/deep indicate reading coverage, not assessed mastery.
- Topic relationships are suggestions, not verified prerequisites.
- Spaced-review cards are local to the browser.
- Queued lessons are not ready content. Owner-only generation retains real pending/result/error feedback.
- Lesson publication is not evidence that software was deployed. Verified deployment records are outside the current lesson-view contract.
- The production app uses React, TypeScript and native CSS with a PWA, GitHub/SWA authentication and existing API contracts. This redesign does not change agents, model configuration, infrastructure, credentials or database schemas.

## Brand Commitments

The user approved the Clear way learning-portal composition on 17 September 2026: a yellow next-lesson direction band, strong humanist headings, quieter supporting content and a comfortable reader. The green tint may be replaced with cool neutrals. Preserve both light and dark preferences.

The product must not inherit PortaBaltica's newsroom composition or identity. The separate 3D experiments are explicitly excluded from the product direction.

## Evidence on Hand

Product purpose is documented in `docs/VISION.md`. Current information and behavior are represented by `src/lib/api.ts`, the lesson/recommendation/topic pages, and their existing backend contracts. The user supplied a screenshot of the approved Clear way study; its example lesson content is not production data and must not be copied into the live application.

## Product Principles

- Make the next useful reading choice clear.
- Explain relevance using real work context and recommendation reasons.
- Let the lesson dominate the reading experience.
- Keep retrieval, recovery and navigation predictable.
- Present observed state honestly, without invented mastery or delivery claims.

## Accessibility and Inclusion

Support comfortable phone reading, English and Russian content, keyboard navigation, visible focus, screen-reader semantics, AA contrast, adequate touch targets and reduced-motion preferences. Missing data, empty collections and service failures need explicit, useful states.
