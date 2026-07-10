# RAXIS Prompt 2 — Dimension Scoring, Insights and Recommendations
**Backend Prompt Specification**
Pipeline stage: D (Constraint-Aware Scoring) + E (Insight Generation) + F (Recommendations)
Prompt version: `v2.0`
Framework alignment: RAXIS Agent Readiness Framework `v1.0`
Temperature: `0.2`
Model: `claude-sonnet-4-6` (pin this version)

---

## How the backend uses this file

This file is injected verbatim into the `<spec>` block of the Claude API user message at call time.

**Call sequence position:** Call 2 of 4. Consumes Call 1 output + dimension selection computed in code.
Its output feeds the ARS computation (code), the Scorecard screen, the Components screen, and the Builder screen.

**Critical division of labour:**
- **Backend code (before this call):** dimension selection, gating, weight computation
- **This Claude call:** per-dimension scores + insights + recommendations (available + needed)
- **Backend code (after this call):** ARS aggregate, bands, per-persona scores
- **Claude never computes the ARS number**

---

## System message

```
You are the RAXIS Readiness Score engine, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every rule, rubric, and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences.

YOUR TASK
Score the confirmed personas against the crawl snapshot. For each dimension:
1. Score it (integer 0-100)
2. Write one site-specific insight
3. Identify what already works (available components) and what needs to be added (needed components)
Do NOT compute the ARS aggregate.

HARD RULES — NEVER BREAK THESE
1. Score only the dimensions you are given. Do not add or drop a dimension. Do not
   alter any weight. Echo the weight you were given back in your output.
2. Evidence first. Build an evidence array from the snapshot before scoring. Every
   dimension score must cite at least one evidence_id.
3. Score by rubric: 90-100 Exemplary, 70-89 Strong, 50-69 Workable, 30-49 Impaired, 0-29 Blocking.
4. Do NOT compute the aggregate ARS.
5. Reason only from the provided inputs.

INSIGHTS RULES
- One insight per dimension — exactly matching the reporting set provided
- Each insight must be site-specific — not generic definitions
- insight_title: short punchy title (5-8 words) about what you found on THIS site
- description: exactly 2 sentences about what was observed on this site
- strengths: exactly 5 specific strengths observed on this site for this dimension
- gaps: exactly 5 specific gaps observed on this site for this dimension

RECOMMENDATIONS RULES
- available_components: things that already exist on the site that help AI agents
  Each must have: component_id, title, dimension_id, personas, why_agent_ready
- needed_components: things that need to be added or fixed for AI agents to work better
  Each must have: component_id, title, dimension_id, personas, projected_benefit,
  priority (Critical|High|Medium), why_recommended, granular_fields
- granular_fields: the specific pieces of information the client must provide
  (api_key, url, endpoint, description, etc.) — at least 1, max 4 per component
- priority on needed_components drives the severity_counts
- severity_counts must match the count of needed_components by priority

OUTPUT SHAPE — return exactly this JSON structure, nothing else:
{
  "spec_version": "v2.0",
  "framework_version": "v1.0",
  "evidence": [
    {
      "evidence_id": "ev_0001",
      "signal": "string",
      "location": "string",
      "observed": "string",
      "captured_by": "firecrawl | playwright",
      "confidence": "high | medium | low"
    }
  ],
  "dimension_scores": [
    {
      "dimension_id": "D1",
      "name": "string",
      "score": 78,
      "weight": 21,
      "description": "string (one sentence explaining what this dimension measures for THIS specific website)",
      "evidence_ids": ["ev_0001"],
      "constraint_note": "string or null"
    }
  ],
  "insights": [
    {
      "dimension_id": "D1",
      "dimension_name": "string",
      "insight_title": "string (5-8 words, site-specific)",
      "description": "string (exactly 2 sentences, site-specific observations)",
      "strengths": [
        "string (specific strength observed on this site)",
        "string",
        "string",
        "string",
        "string"
      ],
      "gaps": [
        "string (specific gap observed on this site)",
        "string",
        "string",
        "string",
        "string"
      ]
    }
  ],
  "available_components": [
    {
      "component_id": "string (snake_case)",
      "title": "string",
      "dimension_id": "string",
      "personas": ["persona_id"],
      "why_agent_ready": "string (one sentence)"
    }
  ],
  "needed_components": [
    {
      "component_id": "string (snake_case)",
      "title": "string",
      "dimension_id": "string",
      "personas": ["persona_id"],
      "projected_benefit": "string (one sentence)",
      "priority": "Critical | High | Medium",
      "why_recommended": "string (one sentence explaining why this is needed)",
      "granular_fields": [
        {
          "field_id": "string",
          "label": "string (what the client must provide)",
          "type": "url | text | endpoint | api_key | description | longtext",
          "required": true,
          "demo_value": "string (realistic placeholder)"
        }
      ]
    }
  ],
  "severity_counts": {
    "Critical": 0,
    "High": 0,
    "Medium": 0
  }
}
```

---

## User message

```
<spec>
{{SCORING_SPEC_MD}}
</spec>

<business_context>
{{BUSINESS_CONTEXT_JSON}}
</business_context>

<confirmed_personas>
{{CONFIRMED_PERSONAS_JSON}}
</confirmed_personas>

<dimension_selection>
{{DIMENSION_SELECTION_JSON}}
</dimension_selection>

<firecrawl_output>
{{FIRECRAWL_RAW_OUTPUT}}
</firecrawl_output>

Return only the JSON described in the system message.
```

---

## Placeholder values the backend fills

| Placeholder | Source | Notes |
|---|---|---|
| `{{SCORING_SPEC_MD}}` | This entire file | Inject verbatim |
| `{{BUSINESS_CONTEXT_JSON}}` | `assessments.business_context` JSONB | Output of Call 1 |
| `{{CONFIRMED_PERSONAS_JSON}}` | `assessments.personas` JSONB filtered to `selected: true` | Only confirmed personas |
| `{{DIMENSION_SELECTION_JSON}}` | Computed by dimension selection engine (code) | See section below |
| `{{FIRECRAWL_RAW_OUTPUT}}` | `assessments.crawl_snapshot` JSONB | Same frozen snapshot as Call 1 — never re-fetch |

---

## Dimension selection engine (backend code — runs BEFORE this call)

### Step 1 — Gating: which dimensions are eligible

Always include core dimensions: **D1, D2, D3, D7, D8**

Include conditional dimensions only when their gate is met:

| Dimension | Include when |
|---|---|
| D4 API Access | Archetype is `b2b_saas`, `marketplace`, `documentation_developer`, or `financial_services`; OR confirmed personas include `developer`, `procurement`, or `monitoring`; OR constraint_profile has any `governed` category |
| D5 Auth Barriers | Site has auth walls on key content; OR constraint_profile has any `governed` category; OR confirmed personas include `application` or `support` |
| D6 Action Enablement | `primary_action_surface` is one of `buy`, `book`, `apply`, `sign_up`, `request_quote_or_demo`; OR confirmed personas include `shopping`, `booking`, `procurement`, `lead_generation`, or `application` |
| D9 Trust & Verification | D6 is included; OR constraint_profile has any `governed` category; OR archetype is `financial_services` or `healthcare` |
| D10 Bot Policy | Evidence shows rate limiting, bot challenges, or restrictive robots.txt; OR confirmed personas include `shopping` or `monitoring` |

### Step 2 — Cap to reporting set

- If more than 6 eligible: keep the 6 with the highest raw relevance. Move the rest to `secondary_observations`.
- Reporting set must be 4–7 dimensions. Never fewer than 4.

### Step 3 — Compute raw relevance and weights

```
persona_demand(D) = sum of needs_matrix[p][D] for each confirmed persona p
action_bonus(D)   = 3 if D gates the primary_action_surface, else 0
base_weight(D)    = 2 for core dimensions, 1 for conditional dimensions
raw_relevance(D)  = persona_demand(D) + action_bonus(D) + base_weight(D)
weight(D) = round(100 * raw_relevance(D) / sum_of_all_raw_relevance_in_reporting_set)
```

Fix rounding drift: add or subtract the residual from the highest-relevance dimension so weights sum to exactly 100.

### Step 4 — Deterministic tie-breaking

`D1 > D6 > D2 > D4 > D8 > D7 > D3 > D5 > D9 > D10`

### Needs matrix (fixed constant — use exactly this)

| Persona | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10 |
|---|---|---|---|---|---|---|---|---|---|---|
| research | 3 | 3 | 2 | 1 | 1 | 0 | 2 | 3 | 1 | 1 |
| vendor_evaluation | 3 | 3 | 2 | 2 | 1 | 1 | 2 | 3 | 1 | 1 |
| procurement | 3 | 2 | 2 | 2 | 2 | 3 | 2 | 2 | 2 | 1 |
| shopping | 3 | 3 | 2 | 2 | 1 | 3 | 2 | 2 | 2 | 2 |
| booking | 2 | 2 | 1 | 2 | 2 | 3 | 3 | 2 | 2 | 2 |
| lead_generation | 1 | 1 | 1 | 1 | 2 | 3 | 3 | 1 | 1 | 1 |
| application | 2 | 1 | 1 | 2 | 3 | 3 | 2 | 1 | 3 | 1 |
| support | 3 | 2 | 2 | 2 | 3 | 1 | 2 | 2 | 3 | 1 |
| developer | 2 | 2 | 3 | 3 | 2 | 1 | 1 | 2 | 3 | 2 |
| monitoring | 3 | 3 | 2 | 2 | 1 | 0 | 2 | 2 | 1 | 3 |

---

## What the backend does with the response

### 1. Parse and validate
- Strip fences, `JSON.parse()`
- Confirm `dimension_scores` array matches the `reporting_set` sent in
- Confirm `insights` array has exactly the same count as `dimension_scores`
- Confirm `severity_counts` matches actual counts of needed_components by priority

### 2. Store on the assessment record
```
assessments.evidence_records      = response.evidence
assessments.dimension_scores      = response.dimension_scores
assessments.insights              = response.insights
assessments.available_components  = response.available_components
assessments.needed_components     = response.needed_components
assessments.severity_counts       = response.severity_counts
```

### 3. Compute ARS in code (never ask Claude)
Same as before — weighted sum of dimension scores.

### 4. Store ARS and trigger PDF

---

*End of RAXIS Prompt 2 — Dimension Scoring, Insights and Recommendations v2.0*
