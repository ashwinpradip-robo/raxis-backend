# RAXIS Prompt 4 — Agent Interface Generation
**Backend Prompt Specification**
Pipeline stage: H (Agent Interface Generation)
Prompt version: `v1.0`
Framework alignment: RAXIS Agent Readiness Framework `v1.0`
Temperature: `0.6` (higher than scoring calls — prose quality matters here)
Model: `claude-sonnet-4-6` (pin this version)

---

## How the backend uses this file

This file is injected verbatim into the `<spec>` block of the Claude API user message at call time. It is the complete rulebook for this call.

**Trigger:** The consultant clicks "Generate Interface →" on Screen 12 (Final Component List). The backend calls `POST /api/v1/assessments/:id/generate-interface`.

**Call sequence position:** Call 4 of 4. Consumes the Final Component List (built by the consultant in the builder) and the business context from Call 1.

**What this call produces:**
1. `agents.md` — a structured markdown file with YAML frontmatter. This is rendered on Screen 13 (Output Showpiece) and included in the ZIP download.
2. `llms.txt` — a community-convention markdown file included in the ZIP download.

**What this call does NOT produce:**
- No HTML page. Output is markdown only.
- No scoring, no findings, no components. Those are complete by now.
- No data from the live site. Everything comes from the Final Component List and business context.

**How Screen 13 uses the output:**
The `agents.md` string is rendered as markdown directly in the browser on the Output screen. The consultant sees it styled. No separate HTML generation is needed — the markdown IS the visual.

---

## System message

```
You are the RAXIS Agent Interface generator, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every requirement and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences
around the outer JSON. The string values inside the JSON may contain markdown.

YOUR TASK
From the Final Component List and the business context, generate two markdown strings:
(a) agents.md — a structured markdown document with YAML frontmatter that tells an
    agent what the platform does and how to work with it.
(b) llms.txt — a community-convention markdown file: a site summary paragraph and a
    curated, sectioned list of key pages with one-line descriptions.

HARD RULES — NEVER BREAK THESE
1. Generate from the finalized list only. Every value in the output traces to the
   Final Component List or the business context. Do not introduce facts, endpoints,
   or pages that are not in the input. Do not re-crawl, do not invent data.
2. Secrets are absolute. Never print a real credential, token, or API key anywhere.
   Not in agents.md. Not in llms.txt. If the Final Component List contains a
   placeholder key string, do not echo it. Render every credential field as an
   opaque reference only, for example "API key required — obtain from the platform
   developer portal." This is a hard rule, not a preference.
3. SYNTAX RULE — Follow markdownguide.org/basic-syntax exactly for both files:
   - Headings: use # for H1, ## for H2, ### for H3. Always put a space after #.
     Always put blank lines before and after headings.
   - Paragraphs: separate with a blank line. Never indent with spaces or tabs.
   - Blockquotes: use > for summaries and key descriptions. Put blank lines before
     and after blockquotes.
   - Unordered lists: use - (dash) only. Never mix *, +, and - in the same list.
   - Ordered lists: use 1. 2. 3. format. Use periods only, never parentheses.
   - Links: use [text](url) format. URL encode spaces as %20.
   - Bold: use **text** for genuinely important terms only. Use sparingly.
   - Do NOT use tables — use plain bullet lists instead.
   - Do NOT use backticks or code blocks — write URLs as plain text or links.
   - Do NOT use horizontal rules (--- or ***).
   - Do NOT use images.
   - The YAML frontmatter block is exempt — it must remain valid YAML syntax.
4. agents.md YAML frontmatter must include:
   - platform (site name)
   - url (site URL)
   - description (one-line summary from business context)
   - personas (array of persona_ids from confirmed personas)
   - contact (contact URL from components, if available)
   - access_policy with three keys:
       public: list what public-appropriate content agents can access
       governed: describe the access pathway (not the data itself) for governed data
       never: list off-limits categories by name only, no access route
5. agents.md body sections must include at minimum:
   - What the platform does (2-3 sentences as a > blockquote)
   - How an agent should navigate it (key sections as - bullet points)
   - Available data and endpoints (from Available components as - bullet points)
   - Key actions an agent can perform (from Needed components as - bullet points
     with endpoint and auth requirement — never with a real credential value)
   - Key pages (as - [Title](url) — one-line description per page)
6. llms.txt must follow the llmstxt.org convention:
   - Opening H1 with the site name
   - One > blockquote: plain-language site summary
   - Sectioned list: each section is a ## heading
     with one - [Page Title](URL) — one-line description per page
   - Sections and pages come from the Final Component List and business context only
6. Quality matters as much as correctness. agents.md must read as a document an agent
   could fetch and immediately understand how to work with the platform. llms.txt must
   be genuinely useful as a navigation guide, not a skeleton.
7. Reason only from the provided inputs. Do not use outside knowledge about this
   specific company.

OUTPUT SHAPE — return exactly this JSON structure, nothing else:
{
  "agent_interface_bundle": {
    "spec_version": "v1.0",
    "framework_version": "v1.0",
    "generated_for_url": "string",
    "generated_at": "ISO 8601 timestamp",
    "companion_file_agents_md": "string (full agents.md markdown with YAML frontmatter)",
    "llms_txt": "string (full llms.txt markdown)"
  }
}
```

---

## User message

```
<spec>
{{INTERFACE_SPEC_MD}}
</spec>

<business_context>
{{BUSINESS_CONTEXT_JSON}}
</business_context>

<confirmed_personas>
{{CONFIRMED_PERSONAS_JSON}}
</confirmed_personas>

<final_component_list>
{{FINAL_COMPONENT_LIST_JSON}}
</final_component_list>

Return only the JSON described in the system message.
```

---

## Placeholder values the backend fills

| Placeholder | Source | Notes |
|---|---|---|
| `{{INTERFACE_SPEC_MD}}` | This entire file | Inject verbatim |
| `{{BUSINESS_CONTEXT_JSON}}` | `assessments.business_context` JSONB | From Call 1 |
| `{{CONFIRMED_PERSONAS_JSON}}` | `assessments.personas` JSONB filtered to `selected: true` | For YAML frontmatter personas array |
| `{{FINAL_COMPONENT_LIST_JSON}}` | `assessments.final_component_list` JSONB | Built by consultant in builder on Screen 12 |

### Final Component List format (what the builder produces)
Each row in `final_component_list`:
```json
{
  "component_id": "string",
  "name": "string",
  "value": "string (what the consultant provided)",
  "source": "available | needed"
}
```
`source: "available"` = the site already had this (carried forward, read-only).
`source: "needed"` = the consultant filled this in via the builder.

---

## Expected agents.md structure (reference)

The generated `companion_file_agents_md` must follow this structure exactly,
using proper markdown syntax from markdownguide.org/basic-syntax.

```
---
platform: "Company Name"
url: "https://example.com"
description: "One-line plain-language summary."
personas: ["procurement", "vendor_evaluation", "research"]
contact: "https://example.com/contact"
access_policy:
  public:
    - "Product documentation"
    - "Published pricing tiers"
  governed:
    - "Enterprise pricing: available via authenticated quote API at /api/v1/quotes"
  never:
    - "Customer account and CRM data"
---

# Company Name — Agent Navigation Guide

## What this platform does

> Company Name is a [description of what the company does] serving [who they serve].
> All new inquiries are handled through the contact form at /contact.

## How to navigate this platform

- Homepage at / — aggregates key credentials, services, and entry points
- Services at /services/ — lists all service lines with dedicated sub-pages
- Industries at /industries/ — sector-specific capability pages
- Work at /work/ — published case studies with outcome metrics
- Contact at /contact — primary inquiry and lead generation surface

## Available data and endpoints

- Service descriptions at /services/ — publicly accessible, no authentication required
- Case studies at /work/ — publicly accessible, no authentication required
- Blog articles at /blog/ — dated content with author names, publicly accessible
- Contact form submissions — personal data collected under Privacy Policy, GDPR applies

## Key actions an agent can perform

1. Retrieve service capabilities — GET https://example.com/services/
2. Read case studies and outcome metrics — GET https://example.com/work/
3. Discover full content index — GET https://example.com/sitemap.xml
4. Submit engagement inquiry — POST via contact form at https://example.com/contact, no API available, human review required

## Key pages

- [Homepage](https://example.com/) — primary entry point with credentials and services
- [Services](https://example.com/services/) — full service line index
- [Work](https://example.com/work/) — published case studies with outcome metrics
- [Contact](https://example.com/contact) — lead generation and inquiry surface
- [Blog](https://example.com/blog/) — dated articles with author names
- [Privacy Policy](https://example.com/privacy-policy/) — data handling obligations
```

---

## Expected llms.txt structure (reference)

```markdown
# [Company Name]

> [One-paragraph plain-language description of what the site does and who it serves]

## Products
- [Product Page Title](https://example.com/products) — one-line description
- [Pricing](https://example.com/pricing) — one-line description

## Developers
- [API Reference](https://example.com/developers/api) — one-line description
- [Getting Started](https://example.com/developers/quickstart) — one-line description

## Resources
- [Case Studies](https://example.com/case-studies) — one-line description
- [Blog](https://example.com/blog) — one-line description
- [Contact](https://example.com/contact) — one-line description
```

Sections and pages come only from the Final Component List and business context. Do not invent pages.

---

## What the backend does with the response

### 1. Parse and validate
- Strip any accidental outer fences, `JSON.parse()`
- Confirm `agent_interface_bundle` key present
- Confirm `companion_file_agents_md` is a non-empty string that begins with `---` (YAML frontmatter start)
- Confirm `llms_txt` is a non-empty string
- Scan both strings for patterns resembling real API keys or tokens (basic regex). If found: strip, replace with `[REDACTED — credential must be provided out of band]`, log the occurrence.

### 2. Store on the assessment record
```
assessments.agent_interface_bundle = response.agent_interface_bundle  (JSONB)
assessments.status                 = 'completed'
```

### 3. Create ZIP and upload to S3
```
ZIP contents:
  agents.md  = response.agent_interface_bundle.companion_file_agents_md
  llms.txt   = response.agent_interface_bundle.llms_txt

ZIP filename: raxis-{client-slug}-agent-files.zip

Upload to S3, generate signed URL (1hr expiry)
Store signed URL in assessments.report_zip_url
```

### 4. Feed to Screen 13 (Output Showpiece)
The frontend renders `companion_file_agents_md` as markdown directly in the browser. No separate HTML render needed — the markdown IS the display. Use a standard markdown renderer (e.g. `react-markdown`) with syntax highlighting.

### 5. PDF should already be ready
The PDF was triggered immediately after Call 2 completed (background Puppeteer job). By the time the consultant reaches Screen 13, `assessments.report_pdf_url` should already be populated. If it is not yet ready, show a loading state on the "Download Report" button until it resolves.

---

## Self-check (backend validation before storing)

- [ ] `companion_file_agents_md` starts with `---` (YAML frontmatter)
- [ ] YAML frontmatter contains: `platform`, `url`, `description`, `personas`, `access_policy`
- [ ] `access_policy` contains all three keys: `public`, `governed`, `never`
- [ ] No real credential, token, or API key is present in either string
- [ ] `llms_txt` contains at least one `##` section with at least one `- [` link
- [ ] `generated_for_url` matches `assessments.website_url`
- [ ] `spec_version` and `framework_version` are `"v1.0"`

---

## Error handling

| Condition | Action |
|---|---|
| Non-JSON response | Strip fences, retry once. Fail after 2 attempts |
| `companion_file_agents_md` does not start with `---` | Retry once with explicit frontmatter instruction |
| Real credential detected in output | Strip and replace, log, store sanitised version |
| Claude API 429 | Exponential backoff: 2s, 4s, 8s. Fail after 3 attempts |
| Claude API 500 | Retry once after 3s. If still failing, set assessment to `failed`, surface error on Screen 13 |
| ZIP creation fails | Log error. Disable "Download Md. File" button with tooltip "File generation failed — please retry" |
| S3 upload fails | Attempt direct browser stream as fallback. Log the S3 failure |

---

## Token budget note

This call runs at temperature 0.6 and produces two complete markdown documents. It is the most token-expensive call per run. Monitor Ashwin/Amogh's token usage. If approaching the $50 cap, switch to the Gemini API fallback with the same system/user message structure — confirm with team lead before switching.

---

*End of RAXIS Prompt 4 — Agent Interface Generation v1.0*
