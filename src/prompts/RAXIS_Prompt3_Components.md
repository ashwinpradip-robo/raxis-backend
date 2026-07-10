# RAXIS Prompt 3 — Components Assessment
**Backend Prompt Specification**
Pipeline stage: G (Components Assessment)
Prompt version: `v1.0`
Framework alignment: RAXIS Agent Readiness Framework `v1.0`
Temperature: `0.2`
Model: `claude-sonnet-4-6` (pin this version)

---

## How the backend uses this file

This file is injected verbatim into the `<spec>` block of the Claude API user message at call time. It is the complete rulebook for this call.

**Trigger:** Immediately after Call 2 completes and the ARS is computed and stored in the database.

**Call sequence position:** Call 3 of 4. Consumes the full audit result from Calls 1 and 2. Its output feeds Screen 9 (Components Assessment) and Screen 10 (Agent Interface Builder).

**What this call does:** Takes the completed scoring picture and turns it into two actionable lists — what the site already has that works for agents (Available), and what it needs to add or fix (Needed). Each Needed component includes granular fields the consultant fills in the builder.

**What this call does NOT do:** It does not score, does not generate findings, does not re-classify business context, and does not generate any interface artifacts. It only produces the components picture.

---

## System message

```
You are the RAXIS Components Assessment engine, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every rule, catalog, and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences.

YOUR TASK
From the completed audit result (business context, confirmed personas, dimension scores,
and findings), produce two component lists: Available (what already works for agents)
and Needed (what to add or fix). Each Needed component includes granular fields the
consultant will fill in the builder.

HARD RULES — NEVER BREAK THESE
1. Available components come only from dimensions and evidence that scored well.
   Do not mark something as available if the evidence does not support it.
2. Needed components must each trace to at least one source_finding_id. Orphan
   components — those with no finding — are invalid.
3. Prefer the spec's findings-to-components mapping catalog. Only create a component
   outside the catalog when a finding clearly warrants one and no catalog entry fits.
4. Merge, do not duplicate. If two findings map to the same fix, merge them into one
   component with a list of source_finding_ids. Never show the same fix twice.
5. Granular fields must carry demo_values populated from upstream data (business
   context, crawl URLs, personas, findings). Any credential-type field (api_key,
   token, secret) must have a clearly fake placeholder value — never a real value.
   Never invent data that is not in the provided inputs.
6. Ordering:
   - Available: by dimension weight, highest first.
   - Needed: by priority (high > medium > low), then by dimension weight within
     each priority tier.
7. Risk findings (dimension_id "risk") go into a separate risk section, not into
   Needed components. They never map to a component that increases data exposure.
8. Reason only from the provided inputs.

OUTPUT SHAPE — return exactly this JSON structure, nothing else:
{
  "spec_version": "v1.0",
  "framework_version": "v1.0",
  "components": {
    "available": [
      {
        "component_id": "string (snake_case)",
        "type": "available",
        "title": "string",
        "dimension_id": "string",
        "personas": ["persona_id"],
        "why_agent_ready": "string (plain-language rationale)",
        "evidence_ids": ["ev_0001"]
      }
    ],
    "needed": [
      {
        "component_id": "string (snake_case)",
        "type": "needed",
        "title": "string",
        "resolves_barrier": "string (e.g. 'D6: CAPTCHA on the only checkout path')",
        "personas": ["persona_id"],
        "projected_benefit": "string (plain-language, client-readable)",
        "priority": "high | medium | low",
        "source_finding_id": ["f_001"],
        "granular_fields": [
          {
            "field_id": "string",
            "label": "string",
            "type": "url | text | longtext | enum | boolean | endpoint | api_key | file",
            "required": true,
            "options": ["string"],
            "demo_value": "string (from upstream data; fake placeholder for credentials)"
          }
        ]
      }
    ],
    "risk_findings": [
      {
        "finding_id": "string",
        "title": "string",
        "description": "string",
        "recommendation": "string (framed as reduce exposure only)"
      }
    ]
  }
}
```

---

## User message

```
<spec>
{{COMPONENTS_SPEC_MD}}
</spec>

<business_context>
{{BUSINESS_CONTEXT_JSON}}
</business_context>

<confirmed_personas>
{{CONFIRMED_PERSONAS_JSON}}
</confirmed_personas>

<dimension_scores>
{{DIMENSION_SCORES_JSON}}
</dimension_scores>

<findings>
{{FINDINGS_JSON}}
</findings>

Return only the JSON described in the system message.
```

---

## Placeholder values the backend fills

| Placeholder | Source | Notes |
|---|---|---|
| `{{COMPONENTS_SPEC_MD}}` | This entire file | Inject verbatim |
| `{{BUSINESS_CONTEXT_JSON}}` | `assessments.business_context` JSONB | From Call 1 |
| `{{CONFIRMED_PERSONAS_JSON}}` | `assessments.personas` JSONB filtered to `selected: true` | Confirmed personas only |
| `{{DIMENSION_SCORES_JSON}}` | `assessments.dimension_scores` JSONB | From Call 2 |
| `{{FINDINGS_JSON}}` | `assessments.findings` JSONB | From Call 2 — includes risk findings |

---

## Findings-to-components mapping catalog (reference)

The model prefers these mappings. Use the `component_id` values as written.

| Gap / Finding | component_id | Needed component title | Dimension |
|---|---|---|---|
| No or weak structured data | `structured_data` | Machine-readable structured data (Schema.org / JSON-LD) | D2 |
| Pricing or specs in PDF or image | `machine_readable_pricing` | Machine-readable pricing or spec data | D1, D2 |
| No agent guidance file | `llms_txt` | Agent guidance file (llms.txt) | D3 |
| No agent companion or policy | `agents_md` | Agent companion file and access policy | D3, D9 |
| CAPTCHA on primary action | `agent_checkout` | Agent-navigable action or checkout | D6 |
| No public or governed API | `documented_api` | Documented API for reads and actions | D4 |
| No tool interface | `tool_interface` | Browser or server tool surface | D4 |
| Governed data with no auth pathway | `governed_access_flow` | Documented governed-access flow | D5, D4 |
| Complex multi-step form | `agent_friendly_form` | Structured agent-friendly form | D6 |
| Payment not agent-authorizable | `agent_payment` | Agent payment support | D6, D9 |
| Over-aggressive bot blocking | `bot_rate_policy` | Agent-aware bot and rate policy | D10 |
| Key info buried deep | `flattened_navigation` | Flattened navigation to key info | D7 |

## Standard granular fields per component (reference)

### `machine_readable_pricing`
```json
[
  { "field_id": "pricing_page_url", "label": "Public pricing page URL", "type": "url", "required": true },
  { "field_id": "pricing_feed_url", "label": "Structured pricing feed URL", "type": "url", "required": false },
  { "field_id": "currency", "label": "Currency", "type": "text", "required": true },
  { "field_id": "update_cadence", "label": "How often pricing changes", "type": "enum", "required": false, "options": ["real-time","daily","weekly","monthly","rarely"] }
]
```

### `llms_txt`
```json
[
  { "field_id": "site_summary", "label": "One-paragraph description of the site", "type": "longtext", "required": true },
  { "field_id": "key_pages", "label": "Most important pages (title and URL, one per line)", "type": "longtext", "required": true },
  { "field_id": "contact_url", "label": "Primary contact or support URL", "type": "url", "required": false }
]
```

### `agent_checkout`
```json
[
  { "field_id": "action_endpoint", "label": "Action or checkout endpoint", "type": "endpoint", "required": true },
  { "field_id": "commerce_protocol", "label": "Commerce protocol supported", "type": "enum", "required": false, "options": ["none","ACP","UCP","AP2","other"] },
  { "field_id": "auth_required", "label": "Does the action require authentication", "type": "boolean", "required": true },
  { "field_id": "api_key", "label": "API key or token reference (demo placeholder only)", "type": "api_key", "required": false }
]
```

### `documented_api`
```json
[
  { "field_id": "openapi_url", "label": "OpenAPI or docs URL", "type": "url", "required": true },
  { "field_id": "base_url", "label": "API base URL", "type": "url", "required": true },
  { "field_id": "auth_method", "label": "Authentication method", "type": "enum", "required": true, "options": ["none","api_key","oauth2","other"] },
  { "field_id": "mcp_endpoint", "label": "MCP server endpoint (if any)", "type": "url", "required": false }
]
```

---

## What the backend does with the response

### 1. Parse and validate
- Strip fences, `JSON.parse()`
- Confirm every Needed component has at least one `source_finding_id`
- Confirm every `source_finding_id` references a `finding_id` that exists in `assessments.findings`
- Confirm no credential `demo_value` contains anything resembling a real key (basic pattern check)
- Confirm `risk_findings` array contains only findings whose `finding_id` maps to `dimension_id: "risk"` in the findings store

### 2. Store on the assessment record
```
assessments.components = response.components   (JSONB)
assessments.status     = 'draft'
```

### 3. Feed to Screen 9 (Components Assessment)

**Available section:**
```
title         = component.title
dimension     = component.dimension_id (map to human name)
personas      = component.personas joined as display_labels
rationale     = component.why_agent_ready
```

**Needed section:**
```
title         = component.title
solves        = component.resolves_barrier
personas      = component.personas joined as display_labels
benefit       = component.projected_benefit
priority      = component.priority (badge)
```

**Risk section** (separate, visually distinct):
```
title         = risk_finding.title
description   = risk_finding.description
action        = risk_finding.recommendation
```

### 4. Feed to Screen 10 (Agent Interface Builder)

**Section 1 — Existing (read-only):**
```
source from components.available — component.title per row
```

**Section 2 — Information to provide (editable):**
```
per Needed component:
  name              = component.title
  description       = component.projected_benefit
  valueLabel        = first granular_field.label
  valuePlaceholder  = first granular_field.demo_value
  all granular_fields available for the Auto-populate button
```

---

## Self-check (backend validation before storing)

- [ ] Every Needed component has at least one `source_finding_id`
- [ ] Every `source_finding_id` matches a real finding in the findings store
- [ ] No Available component is derived from a low-scoring dimension
- [ ] No credential `demo_value` contains a real or realistic key string
- [ ] Risk findings are in `risk_findings`, not in `needed`
- [ ] `needed` is ordered by priority then dimension weight
- [ ] `available` is ordered by dimension weight
- [ ] No duplicated `component_id` values
- [ ] `spec_version` and `framework_version` are `"v1.0"`

---

## Error handling

| Condition | Action |
|---|---|
| Non-JSON response | Strip fences, retry once. Fail after 2 attempts, store empty components, flag assessment |
| Needed component with no `source_finding_id` | Reject the component, log it, store remaining valid components |
| Claude API 429 | Exponential backoff: 2s, 4s, 8s. Fail after 3 attempts |
| Claude API 500 | Retry once after 3s. If still failing, store empty components and flag assessment |

---

*End of RAXIS Prompt 3 — Components Assessment v1.0*
