# Text-controlled personal Wave

Status: design phase

## Product boundary

A listener can describe a music request, for example:
“Спокойный рок из моего вкуса, но с новыми треками”. The proposed feature translates
that request into constrained listening intent and previews a real personal queue.
It is not a voice presenter or a replacement recommendation engine.

Spotify's [DJ](https://support.spotify.com/us/article/dj/) and
[AI Playlist](https://support.spotify.com/mt/article/ai-playlist/) are the product
references. Their feature availability does not confer an audio catalog license,
model API access or a reusable implementation for Soundspan.

## Proposed flow

1. Parse the request into a validated schema: supported mood, familiarity and
   available metadata constraints. Unknown or conflicting constraints require
   clarification rather than silent reinterpretation.
2. Resolve candidates through the existing provider, saved taste and Hybrid
   boundaries. The model cannot invent track IDs, signed audio URLs or access.
3. Apply normal dislikes, version-aware deduplication, cooldown and diversity.
   If the catalog cannot satisfy the request, explain the limitation instead of
   filling the queue with unrelated YouTube search results.
4. Show a short interpretation and real queue preview. Only accepted, actually
   played recommendations contribute ordinary taste signals; generated text and
   previewing a queue are not likes or completed listens.

Do not expose individual listening histories to a model by default. The parser
needs the request and supported schema, not a dump of account data. Explicit
language constraints remain unsupported until reliable catalog-wide coverage is
available; this feature must not silently reintroduce the removed language filter.

## Dependencies and cost

No new paid API or model is configured by this proposal. An existing ChatGPT
subscription is not an application API credential. Cloud inference requires a
separately chosen provider, protected key, cost ceiling and request rate limit;
cost cannot be stated before model and traffic are chosen. A local model uses
server RAM/CPU/GPU and requires a measured capacity check before co-location with
audio services. A rules-only intent parser can prototype the interaction but must
not be advertised as a neural DJ.

## Acceptance before implementation

- The personal mood/discovery engine works without AI and remains the fallback.
- Stable cold playback and recommendation concurrency are separate prerequisites.
- A bounded prompt corpus covers supported, conflicting and impossible requests.
- Every queued recording resolves to a real playable catalog identity.
- No paid service, speech generation or automatic mass playlist creation is enabled
  without an explicit product decision.
