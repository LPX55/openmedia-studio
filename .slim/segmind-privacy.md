Research complete. Here's the report with verified claims vs. gaps clearly separated.

---

# Segmind Data & Privacy Research Report

*Note: the web-search integration returned no results on any query this session, so breach-history checks relied on direct site fetches only. All Segmind claims below come from primary pages I fetched today (2026-10-20).*

## 1. Privacy policy + terms: prompts, inputs/outputs, retention, review

**Privacy policy** (https://www.segmind.com/privacy) — ⚠️ It's a **generic template policy** (Termly-style) that says almost nothing AI-specific:
- Retention: "No purpose in this notice will require us keeping your personal information for longer than three (3) months past the termination of the user's account."
- Never mentions prompts, input images/video, generated outputs, human review, model training, SOC 2, HIPAA, DPAs, or data residency.

**Terms (Main Cloud Services Agreement)** (https://www.segmind.com/terms) — more substantive:
- Customer retains ownership: *"you retain all ownership or license rights in Customer Content, which shall be deemed your Confidential Information."* Content is split into Customer Data (uploads), Customer Instructional Input (prompts/code), and Customer Results (outputs).
- **No AI-training provision exists** — the ToS never claims a right to train on your content. The only sanctioned collection is Usage Data (telemetry), which *"may occasionally contain Customer Instructional Input… but will not contain Customer Data or Customer Results"* (§2.4.3).
- **No content moderation / human-review clause**; support personnel *can* log into customer workspaces (§6.1.9), optionally restrictable.
- **You indemnify Segmind for outputs** — "Customer Results" are Customer Content, so §7's indemnity covers generated outputs, and Segmind "IS NOT RESPONSIBLE FOR RESULTS OBTAINED" (§6.2).
- No numeric uptime SLA in the ToS; content deleted within 30 days of workspace cancellation; *"Segmind does not provide backup for Customer Content."*

**AI Gateway page** (https://www.segmind.com/ai-gateway) — the most specific data statement:
- *"The Segmind AI Gateway keeps each generated file for 7 days, then deletes it automatically… Input images, video and audio sent for inference are not stored; they exist only for the duration of the request."*
- But it also logs heavily: *"Per-request log, cost by model and API key"* — every generation (model, status, duration, cost, request ID) is listed in the console with CSV export. So **metadata is retained persistently; outputs 7 days; inputs not stored**.

## 2. AI Gateway / BYOK: traffic path

**Verified:** BYOK exists — config like `"byok": { "google": "gky_…", "runway": "rwk_…" }`; *"Each hop uses your own provider key if you've plugged one in. Otherwise we use Segmind credits at the same list price."*

**Not documented (explicit gap):** All traffic logically flows through `https://api.segmind.com` (one Segmind key, `x-api-key` header, fallback chains like Veo → Kling → Runway executed server-side). This means **Segmind's infrastructure necessarily sees your prompts, input files, and upstream BYOK keys** — there is no mention of a direct-to-upstream or zero-retention pass-through mode anywhere on the gateway page or in docs.segmind.com's llms-full.txt. The docs' Key Concepts only say third-party models are *"accessed through direct integrations with partner APIs"* (https://docs.segmind.com/docs/get-started/key-concepts), which does not clarify the customer-facing hop. **Ask their team:** (a) is a zero-retention mode available for gateway requests? (b) how are BYOK keys stored/encrypted at rest? (c) is prompt/input logging opt-out-able?

## 3. Training on user data

- **ToS: silent** — no training-on-customer-content right is claimed, but also **no explicit "we never train on your data" promise or opt-out**.
- Privacy policy's closest language is vague CCPA filler: internal research *"for technological development and demonstration."*
- **Verdict: couldn't verify either direction** — this is a gap to confirm contractually for enterprise use.

## 4. Compliance posture

- **SOC 2: Enterprise plan only** — the gateway pricing page lists "99.99% uptime SLA, dedicated Slack support and SOC 2 compliance" as Enterprise features; no report/scope published.
- **GDPR**: privacy policy covers legal bases and EEA/UK complaint rights, but **no DPA, no certification claims**.
- **HIPAA / data residency / region options: not mentioned anywhere.** GAP — must ask.

## 5. Breach history / red flags

- Web search was non-functional this session; direct fetches surfaced nothing, but absence of evidence ≠ clean history. **Couldn't verify.**
- Notable non-breach red flags from documents themselves: generic template privacy policy lacking AI-specific provisions; **your generated outputs are visible in a shared console listing** ("Generations… lists every request"); BYOK keys configured as plaintext config values with no stated key-encryption scheme; indemnification burden for outputs sits on the customer.

## 6. Contrast: fal.ai and Replicate

- **fal.ai** — most granular controls of the three: request payloads stored **90 days by default** with an opt-out header (`X-Fal-Store-IO: 0`) and per-request CDN expiration (`X-Fal-Object-Lifecycle-Preference`); explicitly documents a **"Zero Data Retention (ZDR)"** option; no training-on-user-data claim; no SOC 2 claim in the privacy policy; US processing with SCCs for transfers. Sources: https://fal.ai/docs/documentation/model-apis/media-expiration, https://fal.ai/legal/privacy-policy
- **Replicate** — privacy policy (https://replicate.com/privacy) is generic: retain "as long as necessary," no prompt/output retention periods, no training-on-user-data statement, no SOC 2/GDPR/DPA mention in the policy itself (their /security and /trust URLs 404'd this session — couldn't verify their SOC 2 claims from primary docs).
- **Segmind** — best stated *input* posture (inputs not stored, outputs 7-day TTL) but weakest *documentation* posture: no ZDR mode, no DPA, SOC 2 gated to Enterprise.

**Bottom line:** Segmind's gateway is architecturally a full-proxy (it must see prompts, files, and BYOK keys to do failover), and while its stated retention is favorable, its legal docs are thin. For HeliosGen's desktop-app context (user-owned keys, local data), treat Segmind as **suitable for consumer-grade use, not for sensitive content**, unless their team confirms: zero-retention mode, BYOK key encryption, a signed DPA, and no-training commitment.
