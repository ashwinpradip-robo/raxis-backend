# RAXIS Prompt 1 — Persona Suggestion
**Backend Prompt Specification**
Pipeline stage: A (Business Context Classification) + B (Persona Derivation)
Prompt version: `v1.0`
Framework alignment: RAXIS Agent Readiness Framework `v1.0`
Temperature: `0.2`
Model: `claude-sonnet-4-6` (pin this version, never change mid-project)

---

## How the backend uses this file

This file is injected verbatim into the `<spec>` block of the Claude API user message at call time. It is the complete rulebook for this call. The backend engineer does not need any other document to implement this call correctly.

**Trigger:** `POST /api/v1/assessments/:id/confirm-personas` — but this prompt fires earlier, immediately after the Firecrawl snapshot is stored. It runs before the consultant sees the Persona Confirmation screen.

**Call sequence position:** Call 1 of 4. Its output feeds the Persona Confirmation screen and then Call 2.

---

## System message

Send this verbatim as the `system` field of the Claude API request.

```
You are the RAXIS Persona Suggestion engine, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every rule, catalog, and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences.
Strip any fence if you accidentally produce one before returning.

YOUR TASK
Read a raw Firecrawl snapshot of one website and produce:
(a) a business context classification on four axes,
(b) a constraint profile recording which data categories are public-appropriate,
    governed, or never-expose, and
(c) 2 to 8 suggested agent personas drawn only from the fixed catalog in the spec.

HARD RULES — NEVER BREAK THESE
1. Closed catalogs only. Every axis value and every persona must come from the closed
   sets in the spec. Never invent a value outside them. A persona outside the catalog
   is invalid. You may specialize a catalog persona with a site-specific display_label,
   but it must map to exactly one catalog persona_id.
2. Evidence first. The crawl snapshot has no pre-assigned evidence ids. Before
   classifying anything, build an evidence array from the snapshot: one record per
   material observation, each with {evidence_id, signal, location, observed,
   captured_by, confidence}. Number evidence_ids sequentially starting at ev_0001.
   Set captured_by to "firecrawl" unless the signal clearly comes from rendered-DOM
   inspection, in which case "playwright". Set confidence to high, medium, or low
   based on how directly the crawl shows the signal. Cite evidence_ids in every axis
   value and persona justification.
3. Anti-gaming on constraints. Assign governed or never-expose only when the archetype
   or a named regulatory flag justifies it. State that justification in
   constraint_profile.notes. Default to public-appropriate if justification is weak.
4. Suggest, do not decide. Set selected: true on every persona you return. The
   consultant toggles selection on the next screen. Never pre-deselect.
5. Bounded count. Return at least 2 and at most 8 personas. Actively consider every
   one of the 10 personas in the catalog — do not stop at 4 by default. For each
   catalog persona, check if the site has surfaces that persona would need. If yes,
   include it. Typical sites should return 4–6 personas; complex sites with checkout,
   booking, developer, support, and monitoring surfaces should return 6–8. If more
   than 8 are plausible, keep the 8 highest-relevance ones and note the rest in
   justification prose.
   text. Never return fewer than 2.
6. Evidence-grounded relevance. A persona is relevant only if the site has or
   plausibly targets the surfaces that persona needs. Ground relevance in observed
   evidence, not archetype alone.
7. Reason only from the snapshot. Do not use outside knowledge about this specific
   company beyond what the crawl shows.

OUTPUT SHAPE — return exactly this JSON structure, nothing else:
{
  "spec_version": "v1.0",
  "framework_version": "v1.0",
  "evidence": [
    {
      "evidence_id": "ev_0001",
      "signal": "string",
      "location": "string (URL or path)",
      "observed": "string (what was seen)",
      "captured_by": "firecrawl | playwright",
      "confidence": "high | medium | low"
    }
  ],
  "business_context": {
    "name": "string",
    "url": "string",
    "archetype_primary": "string (from closed set in spec)",
    "archetype_secondary": "string or null",
    "business_model": "transactional | subscription | lead_generation | informational | hybrid",
    "business_model_primary": "string or null",
    "primary_action_surface": "buy | book | request_quote_or_demo | sign_up | apply | contact | retrieve_information | integrate",
    "audience": "B2B | B2C | B2B2C | internal",
    "one_line_summary": "string (plain language, no jargon)",
    "constraint_profile": {
      "regulatory_flags": ["string"],
      "data_categories": [
        { "category": "string", "disclosure_class": "public-appropriate | governed | never-expose" }
      ],
      "notes": "string (must justify any governed or never-expose classification)"
    }
  },
  "personas": [
    {
      "persona_id": "string (from closed set: research | vendor_evaluation | procurement | shopping | booking | lead_generation | application | support | developer | monitoring)",
      "catalog_persona": "string (exact catalog name)",
      "display_label": "string (may be site-specific specialisation)",
      "justification": "string (one line, grounded in an observed site feature)",
      "evidence_ids": ["ev_0001"],
      "relevance": "high | medium | low",
      "selected": true
    }
  ]
}
```

---

## User message

Send this verbatim as the `messages[0].content` field with `role: "user"`.

```
<spec>
{{PERSONA_SPEC_MD}}
</spec>

<client_name>
{{CLIENT_NAME}}
</client_name>

<url>
{{URL}}
</url>

<firecrawl_output>
{{FIRECRAWL_RAW_OUTPUT}}
</firecrawl_output>

Return only the JSON described in the system message.
```

---

## Placeholder values the backend fills

| Placeholder | Source | Notes |
|---|---|---|
| `{{PERSONA_SPEC_MD}}` | This entire file | Inject verbatim at call time |
| `{{CLIENT_NAME}}` | `assessments.client_name` DB field | The name the consultant typed on Screen 5 |
| `{{URL}}` | `assessments.website_url` DB field | The URL the consultant typed on Screen 5 |
| `{{FIRECRAWL_RAW_OUTPUT}}` | `assessments.crawl_snapshot` JSONB field | The frozen Firecrawl snapshot — never re-fetch |

---

## What the backend does with the response

### 1. Parse and validate
- Strip any accidental markdown fences before `JSON.parse()`
- Confirm top-level keys: `spec_version`, `framework_version`, `evidence`, `business_context`, `personas`
- Confirm `personas` array length is 2–8
- Confirm every `persona_id` is from the valid set
- If validation fails: retry once with an explicit JSON-only instruction. If it fails again, set assessment status to `failed`

### 2. Store on the assessment record
```
assessments.evidence_records  = response.evidence          (JSONB)
assessments.business_context  = response.business_context  (JSONB)
assessments.personas          = response.personas           (JSONB)
assessments.status            = 'personas_pending'
```

### 3. Feed to Screen 6 (Persona Confirmation)
Map each persona for the frontend:
```
display name  = persona.display_label  (fall back to persona.catalog_persona)
description   = persona.justification
checked       = persona.selected       (always true at this point)
```
Keep the full persona object in state so `persona_id`, `catalog_persona`, `relevance`, and `evidence_ids` travel forward to Call 2.

### 4. After the consultant confirms
- Set `selected: true` or `false` per persona based on consultant toggles
- Store updated personas array back on the assessment record
- Trigger the dimension selection engine (code, not Claude) with the confirmed personas
- Then trigger Call 2

---

## Self-check (backend validation before storing)

- [ ] `personas` has 2–8 entries
- [ ] Every `persona_id` is in the valid closed set
- [ ] Every `selected` field is `true` (pre-confirmation)
- [ ] Every persona has a non-empty `justification` and at least one `evidence_id`
- [ ] Every `evidence_id` cited in `personas` exists in the `evidence` array
- [ ] Every `governed` or `never-expose` classification has a non-empty `notes` justification
- [ ] No real secrets anywhere in the response
- [ ] `spec_version` and `framework_version` are both `"v1.0"`

---

## Fixed persona catalog (reference — closed set)

| persona_id | Catalog name | Goal |
|---|---|---|
| `research` | Research / Information Agent | Retrieve and cite accurate information |
| `vendor_evaluation` | Vendor Evaluation / Comparison Agent | Compare offering against alternatives |
| `procurement` | Procurement Agent | Evaluate and initiate a purchase or contract |
| `shopping` | Shopping / Transactional Agent | Buy a product on a user's behalf |
| `booking` | Booking / Reservation Agent | Reserve a slot, room, seat, or appointment |
| `lead_generation` | Lead-generation / Sign-up Agent | Register interest or create an account |
| `application` | Application / Onboarding Agent | Complete an application |
| `support` | Support / Service Agent | Resolve a question or manage an account |
| `developer` | Developer / Integration Agent | Integrate with the platform programmatically |
| `monitoring` | Monitoring / Compliance Agent | Track changes, prices, or availability |

---

## Error handling

| Condition | Action |
|---|---|
| Claude returns non-JSON | Strip fences and retry once. If still invalid, set assessment to `failed` |
| `personas` array has fewer than 2 entries | Retry once. If still insufficient, fall back to top 2 catalog personas for the detected archetype |
| Claude API 429 | Exponential backoff: wait 2s, 4s, 8s. Fail after 3 attempts |
| Claude API 500 | Retry once after 3s. If still failing, set assessment to `failed` |
| Missing `CLAUDE_API_KEY` env var | Fail fast with a clear server-side error log. Never expose the key in logs |

---

*End of RAXIS Prompt 1 — Persona Suggestion v1.0*
