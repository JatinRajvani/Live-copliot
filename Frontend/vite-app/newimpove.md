# AI Live Copilot - Stage 2 Execution Plan

## Goal

Stabilize the speech pipeline so imperfect STT does not degrade copilot quality.

Pipeline focus:

Call -> Transcription -> Correction -> Validation -> AI -> Response

## Current State

- Twilio call streaming is working.
- Deepgram transcription is integrated.
- AI response pipeline is functional.
- Remaining issue: inconsistent transcript quality causes inconsistent AI outputs.

## Delivery Principles

- Prioritize deterministic fixes before AI-based fixes.
- Measure each change with explicit acceptance criteria.
- Keep risky behavior behind feature flags for rollback.

## Stage Gates

- Gate 1: Items 1 to 5 completed and verified.
- Gate 2: Items 6 to 9 completed and verified.
- Gate 3: Items 10 and 11 completed with passing scorecard.
- Gate 4: Item 12 only after all prior gates pass.

## Execution Checklist

### Phase A - Input Stability and Hygiene

- [x] 1. Add stabilization buffer before STT call
  - Goal: avoid tiny/noisy chunks.
  - Action: minimum chunk threshold + silence debounce + short pre-STT stabilization delay.
  - Config: `STT_STABILIZATION_MS=300-500` (recommended default: `350`).
  - Success check: fewer short transcript artifacts and fewer silence hallucinations.

- [x] 2. Process only stable transcript events
  - Goal: prevent reactions to partial text.
  - Action: forward only finalized/stable chunk outputs to downstream stages.
  - Success check: AI suggestions stop changing repeatedly for the same utterance.

- [x] 3. Add deterministic correction map
  - Goal: fix repeated known mistakes quickly.
  - Action: normalize known substitutions (example: `yatin -> Jatin`, `nixon -> Nexon`).
  - Success check: measurable drop in repeated name/brand errors.

- [x] 4. Add strict transcript quality gate
  - Goal: block garbage before AI.
  - Action: reject text that is too short, punctuation-only, repeated hallucination patterns, or invalid token structure.
  - Success check: fewer useless AI responses and cleaner transcript timeline.

- [x] 5. Add structured observability logs
  - Goal: debug issues quickly.
  - Action: log `RAW`, `CORRECTED`, `AI_INPUT`, `AI_OUTPUT` with timestamp and speaker.
  - Success check: any quality regression is traceable to a specific stage.

### Phase B - Accuracy and AI Quality

- [x] 6. Tune Deepgram for domain terms
  - Goal: improve proper noun recognition.
  - Action: add domain-specific biasing/boost terms for names, products, IDs, and locations.
  - Success check: improved recognition score for predefined domain terms.

- [x] 7. Add entity validation for critical tokens
  - Goal: protect numbers and IDs.
  - Action: validate and normalize order IDs, prices, dates, versions, and phone-like strings before AI usage.
  - Success check: fewer wrong order/version/price outputs.

- [x] 8. Strengthen system prompt
  - Goal: keep copilot outputs concise and actionable despite noisy input.
  - Action: enforce direct response style and no "ask again" fallback behavior.
  - Success check: higher consistency in hint usefulness and relevance.

- [x] 9. Add lightweight domain grounding
  - Goal: reduce generic responses.
  - Action: inject a small curated product facts object in prompt context.
  - Success check: responses include correct domain facts more often.

### Phase C - Validation and Rollout

- [ ] 10. Add A/B switch for STT providers
  - Goal: compare Deepgram vs Groq objectively.
  - Action: keep provider toggle in environment config and run identical test script on both.
  - Success check: side-by-side scorecard for accuracy, latency, hallucination rate.

- [ ] 11. Define pass/fail scorecard and run mobile tests
  - Goal: release with confidence.
  - Action: test wired and Bluetooth; normal and fast speech; mixed English-Hindi; numeric-heavy phrases.
  - Success check: stable score across repeated runs, not one-off success.

- [ ] 12. Add AI-based correction layer (optional, last)
  - Goal: final polish only.
  - Action: constrain to proper noun correction; never rewrite meaning or factual intent.
  - Success check: improves proper nouns without introducing semantic drift.

## Acceptance Metrics

Use these as minimum release targets:

- Proper noun accuracy: >= 90%
- Number and ID accuracy: >= 95%
- Hallucination rate: <= 2%
- Median transcript latency: <= 1.5 s
- Speaker label correctness: >= 95%

## Test Protocol

Run each test case for both providers with the same script and environment:

1. Normal pace speech
2. Fast speech
3. Mixed English-Hindi
4. Number/ID-heavy utterances
5. Low, normal, and loud voice levels
6. Wired headset and Bluetooth headset

## Rollback Controls

Keep each major improvement behind a feature flag where possible:

- transcript quality gate on/off
- correction map on/off
- domain grounding on/off
- provider selection via env

If a regression appears, disable the last enabled feature and rerun the scorecard.