# Wave mood consistency

Scope: three visible moods (neutral, calm, energetic); retain direction controls and Hybrid 50%. Legacy focus maps to calm, workout to energetic, favorites/forgotten to neutral in new UI. Old API callers remain compatible.

- [x] Add failing behavioral tests for per-lane mood eligibility and legacy selection migration.
- [x] Enforce measured intensity eligibility for explicit Wave moods before either ranker, across every lane. Calm <=0.45; energetic >=0.55; finite normalized arousal only (RMS loudness is not perceptual intensity). Legacy focus/workout use equivalent eligibility while their old ranking remains compatible. Neutral unaffected.
- [x] Reduce visible choices, normalize persisted/URL settings, explain shortage without relaxing mood.
- [x] Tests/typechecks/build; paired diagnostic production-data replay against candidate code.
- [x] Ordinary and adversarial review; guarded release and smoke with rollback. No git push.

Acceptance: no unknown or opposite-intensity recording in explicit mood shelves, including discovery and listenAgain; neutral behavior and account exclusions preserved. These are acoustic constraints, not proof of subjective mood classification. Short queues remain possible.
