// ─────────────────────────────────────────────────────────────────────────────
// RAXIS Pipeline — 4 Claude API Calls
// This file orchestrates the complete AI pipeline.
// Called by crawl.ts background jobs.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import { supabase } from "../lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// LLM API helper
// Priority: Bedrock (production) → Claude direct → Gemini (testing)
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_API_URL  = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
const CLAUDE_API_URL  = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL    = "claude-sonnet-4-6";
const BEDROCK_MODEL   = "us.anthropic.claude-sonnet-4-6";
const BEDROCK_REGION  = process.env.AWS_REGION ?? "us-west-2";

async function callClaude(
  systemPrompt: string,
  userMessage: string,
  temperature: number = 0.2,
  maxTokens: number = 8000
): Promise<string> {
  const awsAccessKey    = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretKey    = process.env.AWS_SECRET_ACCESS_KEY;
  const claudeDirectKey = process.env.CLAUDE_API_KEY;
  const geminiKey       = process.env.GEMINI_API_KEY;

  if (awsAccessKey && awsSecretKey) {
    console.log("[LLM] Using Claude via AWS Bedrock (us-west-2)");
    return callBedrock(systemPrompt, userMessage, temperature, maxTokens, awsAccessKey, awsSecretKey);
  } else if (claudeDirectKey) {
    console.log("[LLM] Using Claude direct API");
    return callAnthropicClaude(systemPrompt, userMessage, temperature, maxTokens, claudeDirectKey);
  } else if (geminiKey) {
    console.log("[LLM] Using Gemini 3.5 Flash — no Claude key set");
    return callGemini(systemPrompt, userMessage, temperature, maxTokens, geminiKey);
  } else {
    throw new Error("No LLM key found. Set AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY, CLAUDE_API_KEY, or GEMINI_API_KEY in .env");
  }
}

// ── AWS Bedrock ───────────────────────────────────────────────────────────────

async function callBedrock(
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  maxTokens: number,
  accessKeyId: string,
  secretAccessKey: string
): Promise<string> {
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const region       = BEDROCK_REGION;
  const model        = encodeURIComponent(BEDROCK_MODEL);
  const endpoint     = `https://bedrock-runtime.${region}.amazonaws.com/model/${model}/invoke`;

  const bodyObj = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens:        maxTokens,
    temperature,
    system:            systemPrompt,
    messages:          [{ role: "user", content: userMessage }],
  };
  const body = JSON.stringify(bodyObj);

  const signedHeaders = await signAWS4({
    method: "POST", url: endpoint, region,
    service: "bedrock", body, accessKeyId, secretAccessKey, sessionToken,
  });

  let attempt = 0;
  const delays = [5000, 15000, 30000];

  while (attempt <= 2) {
    try {
      // Add Content-Type explicitly here — it is NOT in signedHeaders
      // to avoid duplicate header issues with AWS signature verification
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...signedHeaders },
        body,
      });

      if (response.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, delays[attempt])); attempt++; continue;
      }
      if (!response.ok) {
        const err = await response.text().catch(() => response.statusText);
        throw new Error(`Bedrock error ${response.status}: ${err}`);
      }
      const data = await response.json();
      return stripFences(data.content?.[0]?.text ?? "");
    } catch (err) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, delays[attempt])); attempt++; }
      else throw err;
    }
  }
  throw new Error("Bedrock failed after 3 attempts");
}

async function signAWS4(p: {
  method: string; url: string; region: string; service: string;
  body: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string;
}): Promise<Record<string, string>> {
  const enc      = new TextEncoder();
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const host     = new URL(p.url).host;

  const bodyHashBuf = await crypto.subtle.digest("SHA-256", enc.encode(p.body));
  const bodyHash    = Array.from(new Uint8Array(bodyHashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  // Sign only host and x-amz-date — do NOT include content-type in signed headers
  // because Node.js fetch adds Content-Type automatically, causing a duplicate
  // which breaks the AWS signature verification
  const hdrs: Record<string, string> = { "host": host, "x-amz-date": amzDate };
  if (p.sessionToken) hdrs["x-amz-security-token"] = p.sessionToken;

  const signedKeys     = Object.keys(hdrs).sort().join(";");
  const canonicalHdrs  = Object.keys(hdrs).sort().map(k => `${k}:${hdrs[k]}
`).join("");
  const canonical      = [p.method, new URL(p.url).pathname, "", canonicalHdrs, signedKeys, bodyHash].join("\n");
  const credScope      = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const canonHashBuf   = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
  const canonHash      = Array.from(new Uint8Array(canonHashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  const strToSign      = `AWS4-HMAC-SHA256
${amzDate}
${credScope}
${canonHash}`;

  async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", k, enc.encode(data));
  }

  const kDate    = await hmac(enc.encode(`AWS4${p.secretAccessKey}`), dateStamp);
  const kRegion  = await hmac(kDate, p.region);
  const kService = await hmac(kRegion, p.service);
  const kSign    = await hmac(kService, "aws4_request");
  const sigBuf   = await hmac(kSign, strToSign);
  const sig      = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  return { ...hdrs, "Authorization": `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${credScope}, SignedHeaders=${signedKeys}, Signature=${sig}` };
}

// ── Anthropic Claude direct API ───────────────────────────────────────────────

async function callAnthropicClaude(
  systemPrompt: string, userMessage: string,
  temperature: number, maxTokens: number, apiKey: string
): Promise<string> {
  let attempt = 0;
  const delays = [5000, 15000, 30000];
  while (attempt <= 2) {
    try {
      const response = await fetch(CLAUDE_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, temperature, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }),
      });
      if (response.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, delays[attempt])); attempt++; continue; }
      if (!response.ok) { const err = await response.text().catch(() => response.statusText); throw new Error(`Claude error ${response.status}: ${err}`); }
      const data = await response.json();
      return stripFences(data.content?.[0]?.text ?? "");
    } catch (err) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, delays[attempt])); attempt++; } else throw err;
    }
  }
  throw new Error("Claude direct API failed after 3 attempts");
}

// ── Google Gemini fallback ────────────────────────────────────────────────────

async function callGemini(
  systemPrompt: string, userMessage: string,
  temperature: number, maxTokens: number, apiKey: string
): Promise<string> {
  let attempt = 0;
  const delays = [5000, 15000, 30000];
  while (attempt <= 2) {
    try {
      const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
        }),
      });
      if (response.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, delays[attempt])); attempt++; continue; }
      if (!response.ok) { const err = await response.text().catch(() => response.statusText); throw new Error(`Gemini error ${response.status}: ${err}`); }
      const data = await response.json();
      return stripFences(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    } catch (err) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, delays[attempt])); attempt++; } else throw err;
    }
  }
  throw new Error("Gemini API failed after 3 attempts");
}

// ── Shared helper ─────────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// safeParseJSON — attempts to parse JSON, with truncation repair as fallback
// Claude sometimes truncates output mid-JSON when response is very long.
// This function tries to repair truncated JSON by closing open structures.
function safeParseJSON(raw: string): Record<string, unknown> {
  const cleaned = stripFences(raw);

  // First try: direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // Second try: attempt to repair truncated JSON
    // Find the last complete top-level field and close the object
    let repaired = cleaned;

    // Remove trailing incomplete string/value
    repaired = repaired.replace(/,\s*"[^"]*$/, "");
    repaired = repaired.replace(/,\s*[^,{[\]}"]*$/, "");

    // Count unclosed brackets and braces
    let openBraces   = 0;
    let openBrackets = 0;
    let inString     = false;
    let escape       = false;

    for (const ch of repaired) {
      if (escape)       { escape = false; continue; }
      if (ch === "\\")  { escape = true;  continue; }
      if (ch === '"')   { inString = !inString; continue; }
      if (inString)     continue;
      if (ch === "{")   openBraces++;
      if (ch === "}")   openBraces--;
      if (ch === "[")   openBrackets++;
      if (ch === "]")   openBrackets--;
    }

    // Close unclosed structures
    while (openBrackets > 0) { repaired += "]"; openBrackets--; }
    while (openBraces   > 0) { repaired += "}"; openBraces--;   }

    return JSON.parse(repaired);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read prompt spec files
// These files are the system prompt + spec injected into each Claude call.
// In production they live in src/prompts/ — copy them there.
// ─────────────────────────────────────────────────────────────────────────────

function readPromptSpec(filename: string): string {
  const promptsDir = path.join(__dirname, "..", "prompts");
  const filePath   = path.join(promptsDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt spec file not found: ${filePath}. Copy prompt files to src/prompts/`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension names lookup (for building dimension_selection)
// ─────────────────────────────────────────────────────────────────────────────

const DIMENSION_NAMES: Record<string, string> = {
  D1:  "Data Accessibility and Extractability",
  D2:  "Structured Data and Semantics",
  D3:  "Content Structure and Navigation Semantics",
  D4:  "API and Programmatic Access",
  D5:  "Authentication and Access Barriers",
  D6:  "Action Enablement",
  D7:  "Navigation Clarity and Discoverability",
  D8:  "Content Freshness and Reliability Signals",
  D9:  "Trust, Verification and Safety Signals",
  D10: "Bot Policy and Rate Limiting",
};

// Core dimensions — always included
const CORE_DIMENSIONS = ["D1", "D2", "D3", "D7", "D8"];

// Tie-breaking priority order (lower index = higher priority)
const TIE_BREAK_ORDER = ["D1", "D6", "D2", "D4", "D8", "D7", "D3", "D5", "D9", "D10"];

// Needs matrix — fixed constant from the framework
const NEEDS_MATRIX: Record<string, Record<string, number>> = {
  research:          { D1:3, D2:3, D3:2, D4:1, D5:1, D6:0, D7:2, D8:3, D9:1, D10:1 },
  vendor_evaluation: { D1:3, D2:3, D3:2, D4:2, D5:1, D6:1, D7:2, D8:3, D9:1, D10:1 },
  procurement:       { D1:3, D2:2, D3:2, D4:2, D5:2, D6:3, D7:2, D8:2, D9:2, D10:1 },
  shopping:          { D1:3, D2:3, D3:2, D4:2, D5:1, D6:3, D7:2, D8:2, D9:2, D10:2 },
  booking:           { D1:2, D2:2, D3:1, D4:2, D5:2, D6:3, D7:3, D8:2, D9:2, D10:2 },
  lead_generation:   { D1:1, D2:1, D3:1, D4:1, D5:2, D6:3, D7:3, D8:1, D9:1, D10:1 },
  application:       { D1:2, D2:1, D3:1, D4:2, D5:3, D6:3, D7:2, D8:1, D9:3, D10:1 },
  support:           { D1:3, D2:2, D3:2, D4:2, D5:3, D6:1, D7:2, D8:2, D9:3, D10:1 },
  developer:         { D1:2, D2:2, D3:3, D4:3, D5:2, D6:1, D7:1, D8:2, D9:3, D10:2 },
  monitoring:        { D1:3, D2:3, D3:2, D4:2, D5:1, D6:0, D7:2, D8:2, D9:1, D10:3 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Dimension Selection Engine (pure code — no Claude)
// ─────────────────────────────────────────────────────────────────────────────

interface DimensionSelection {
  reporting_set: Array<{ dimension_id: string; name: string; weight: number }>;
  secondary_observations: string[];
  excluded: string[];
}

function runDimensionSelection(
  businessContext: Record<string, unknown>,
  confirmedPersonas: Array<{ persona_id: string; selected: boolean }>
): DimensionSelection {
  const personaIds  = confirmedPersonas.filter(p => p.selected).map(p => p.persona_id);
  const archetype   = (businessContext.archetype_primary as string ?? "").toLowerCase();
  const actionSurf  = (businessContext.primary_action_surface as string ?? "").toLowerCase();
  const constraint  = businessContext.constraint_profile as Record<string, unknown> ?? {};
  const dataCategories = (constraint.data_categories as Array<{ disclosure_class: string }>) ?? [];
  const hasGoverned = dataCategories.some(d => d.disclosure_class === "governed");

  // Step 1 — Gating
  const eligible = new Set<string>(CORE_DIMENSIONS);

  // D4 — API Access
  if (
    ["b2b_saas", "marketplace", "documentation_developer", "financial_services"].includes(archetype) ||
    personaIds.some(p => ["developer", "procurement", "monitoring"].includes(p)) ||
    hasGoverned
  ) eligible.add("D4");

  // D5 — Auth Barriers
  if (
    hasGoverned ||
    personaIds.some(p => ["application", "support"].includes(p))
  ) eligible.add("D5");

  // D6 — Action Enablement
  if (
    ["buy", "book", "apply", "sign_up", "request_quote_or_demo"].includes(actionSurf) ||
    personaIds.some(p => ["shopping", "booking", "procurement", "lead_generation", "application"].includes(p))
  ) eligible.add("D6");

  // D9 — Trust & Verification
  if (
    eligible.has("D6") ||
    hasGoverned ||
    ["financial_services", "healthcare"].includes(archetype)
  ) eligible.add("D9");

  // D10 — Bot Policy
  if (personaIds.some(p => ["shopping", "monitoring"].includes(p))) eligible.add("D10");

  // Step 2 — Compute raw relevance
  const relevance: Record<string, number> = {};
  for (const dim of eligible) {
    const personaDemand = personaIds.reduce((sum, p) => sum + (NEEDS_MATRIX[p]?.[dim] ?? 0), 0);
    const actionBonus   = (
      (dim === "D6" && ["buy","book","apply","sign_up","request_quote_or_demo"].includes(actionSurf)) ||
      (dim === "D4" && actionSurf === "integrate")
    ) ? 3 : 0;
    const baseWeight    = CORE_DIMENSIONS.includes(dim) ? 2 : 1;
    relevance[dim]      = personaDemand + actionBonus + baseWeight;
  }

  // Step 3 — Cap to 6 max
  let reportingDims = Array.from(eligible);
  if (reportingDims.length > 6) {
    reportingDims.sort((a, b) => {
      const diff = (relevance[b] ?? 0) - (relevance[a] ?? 0);
      if (diff !== 0) return diff;
      return TIE_BREAK_ORDER.indexOf(a) - TIE_BREAK_ORDER.indexOf(b);
    });
    reportingDims = reportingDims.slice(0, 6);
  }

  // Ensure minimum of 4
  if (reportingDims.length < 4) {
    for (const d of CORE_DIMENSIONS) {
      if (!reportingDims.includes(d)) reportingDims.push(d);
      if (reportingDims.length >= 4) break;
    }
  }

  // Step 4 — Compute weights
  const totalRelevance = reportingDims.reduce((s, d) => s + (relevance[d] ?? 1), 0);
  const weights: Record<string, number> = {};
  let weightSum = 0;

  for (const d of reportingDims) {
    weights[d] = Math.round(100 * (relevance[d] ?? 1) / totalRelevance);
    weightSum += weights[d];
  }

  // Fix rounding drift — add/subtract from highest relevance dimension
  const drift = 100 - weightSum;
  if (drift !== 0) {
    const highest = reportingDims.reduce((a, b) => (relevance[a] ?? 0) >= (relevance[b] ?? 0) ? a : b);
    weights[highest] += drift;
  }

  const excluded = Array.from({ length: 10 }, (_, i) => `D${i + 1}`)
    .filter(d => !eligible.has(d));
  const secondary = Array.from(eligible).filter(d => !reportingDims.includes(d));

  return {
    reporting_set: reportingDims.map(d => ({
      dimension_id: d,
      name:         DIMENSION_NAMES[d] ?? d,
      weight:       weights[d] ?? 0,
    })),
    secondary_observations: secondary,
    excluded,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARS Computation (pure code — Claude never computes this)
// ─────────────────────────────────────────────────────────────────────────────

function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

function arsBand(score: number): string {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "needs_work";
  return "not_ready";
}

function computeARS(dimensionScores: Array<{ dimension_id: string; score: number; weight: number }>): number {
  const raw = dimensionScores.reduce((sum, d) => sum + (d.score * d.weight / 100), 0);
  return roundHalfUp(raw);
}

function computePersonaScores(
  confirmedPersonas: Array<{ persona_id: string; display_label?: string; selected: boolean }>,
  dimensionScores: Array<{ dimension_id: string; score: number; weight: number }>
): Array<{ persona_id: string; display_label: string; score: number; band: string }> {
  return confirmedPersonas
    .filter(p => p.selected)
    .map(p => {
      const row         = NEEDS_MATRIX[p.persona_id] ?? {};
      const totalDemand = dimensionScores.reduce((s, d) => s + (row[d.dimension_id] ?? 0), 0);
      if (totalDemand === 0) return null;
      const weighted = dimensionScores.reduce((s, d) => {
        const w = (row[d.dimension_id] ?? 0) / totalDemand;
        return s + d.score * w;
      }, 0);
      const score = roundHalfUp(weighted);
      return {
        persona_id:    p.persona_id,
        display_label: p.display_label ?? p.persona_id,
        score,
        band:          arsBand(score),
      };
    })
    .filter(Boolean) as Array<{ persona_id: string; display_label: string; score: number; band: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Call 1: Persona Suggestion
// ─────────────────────────────────────────────────────────────────────────────

export async function runPersonaSuggestion(
  assessmentId: string,
  clientName: string,
  url: string,
  crawlSnapshot: Record<string, unknown>,
  _consultantId: string
): Promise<void> {
  console.log(`[Call1 ${assessmentId}] Starting persona suggestion`);

  const specMd      = readPromptSpec("RAXIS_Prompt1_Persona.md");
  const crawlOutput = JSON.stringify(crawlSnapshot).slice(0, 80000); // Token guard for very large sites

  const systemPrompt = `You are the RAXIS Persona Suggestion engine, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every rule, catalog, and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences.
Strip any fence if you accidentally produce one before returning.

YOUR TASK
Read a raw Firecrawl snapshot of one website and produce:
(a) a business context classification on four axes,
(b) a constraint profile recording which data categories are public-appropriate,
    governed, or never-expose, and
(c) 2 to 4 suggested agent personas drawn only from the fixed catalog in the spec.`;

  const userMessage = `<spec>
${specMd}
</spec>

<client_name>
${clientName}
</client_name>

<url>
${url}
</url>

<firecrawl_output>
${crawlOutput}
</firecrawl_output>

Return only the JSON described in the system message.`;

  let parsed: Record<string, unknown>;

  try {
    // Increase max_tokens to 16000 to prevent truncation on large sites
    const raw    = await callClaude(systemPrompt, userMessage, 0.2, 16000);
    parsed       = safeParseJSON(raw);
  } catch (err) {
    console.error(`[Call1 ${assessmentId}] Failed:`, err);
    await supabase.from("assessments").update({ status: "failed" }).eq("id", assessmentId);
    return;
  }

  // Validate
  const personas = parsed.personas as Array<Record<string, unknown>>;
  if (!Array.isArray(personas) || personas.length < 2) {
    console.error(`[Call1 ${assessmentId}] Invalid personas count: ${personas?.length}`);
    await supabase.from("assessments").update({ status: "failed" }).eq("id", assessmentId);
    return;
  }

  // Store
  await supabase
    .from("assessments")
    .update({
      business_context: parsed.business_context,
      personas:         personas,
      evidence_records: parsed.evidence,
      status:           "personas_pending",
    })
    .eq("id", assessmentId);

  console.log(`[Call1 ${assessmentId}] Complete — ${personas.length} personas suggested`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Calls 2 + 3: Scoring, Findings, ARS, then Components
// ─────────────────────────────────────────────────────────────────────────────

export async function runScoringAndComponents(
  assessmentId: string,
  _consultantId: string
): Promise<void> {
  // Fetch current assessment state
  const { data: assessment, error } = await supabase
    .from("assessments")
    .select("business_context, personas, crawl_snapshot")
    .eq("id", assessmentId)
    .single();

  if (error || !assessment) {
    throw new Error(`Assessment ${assessmentId} not found`);
  }

  const businessContext    = assessment.business_context as Record<string, unknown>;
  const confirmedPersonas  = (assessment.personas as Array<{ persona_id: string; display_label?: string; selected: boolean }>)
    .filter(p => p.selected);
  const crawlSnapshot      = assessment.crawl_snapshot as Record<string, unknown>;

  // ── Run dimension selection engine (pure code) ──────────────────────────
  const dimensionSelection = runDimensionSelection(businessContext, confirmedPersonas);
  await supabase
    .from("assessments")
    .update({ dimension_selection: dimensionSelection })
    .eq("id", assessmentId);

  console.log(`[Call2 ${assessmentId}] Dimension selection: ${dimensionSelection.reporting_set.map(d => d.dimension_id).join(", ")}`);

  // ── Call 2: Scoring + Findings ──────────────────────────────────────────
  console.log(`[Call2 ${assessmentId}] Starting scoring`);

  const scoringSpec   = readPromptSpec("RAXIS_Prompt2_Scoring.md");
  const crawlOutput   = JSON.stringify(crawlSnapshot).slice(0, 80000);

  const scoringSystem = `You are the RAXIS Readiness Score engine, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every rule, rubric, and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences.

YOUR TASK
Score the confirmed personas against the crawl snapshot. You are given the
reporting-set dimensions and their weights, already computed in code. Score only
those dimensions. Write findings. Do NOT compute the ARS aggregate.`;

  const scoringUser = `<spec>
${scoringSpec}
</spec>

<business_context>
${JSON.stringify(businessContext)}
</business_context>

<confirmed_personas>
${JSON.stringify(confirmedPersonas)}
</confirmed_personas>

<dimension_selection>
${JSON.stringify(dimensionSelection)}
</dimension_selection>

<firecrawl_output>
${crawlOutput}
</firecrawl_output>

Return only the JSON described in the system message.`;

  let scoringResult: Record<string, unknown>;
  try {
    const raw     = await callClaude(scoringSystem, scoringUser, 0.2, 16000);
    scoringResult = safeParseJSON(raw);
  } catch (err) {
    console.error(`[Call2 ${assessmentId}] Failed:`, err);
    await supabase.from("assessments").update({ status: "failed" }).eq("id", assessmentId);
    return;
  }

  const dimensionScores      = scoringResult.dimension_scores as Array<{ dimension_id: string; score: number; weight: number }>;
  const insights             = scoringResult.insights as Array<Record<string, unknown>>;
  const availableComponents  = scoringResult.available_components as Array<Record<string, unknown>>;
  const neededComponents     = scoringResult.needed_components as Array<Record<string, unknown>>;
  const severityCounts       = scoringResult.severity_counts as Record<string, number>;

  // Validate
  if (!Array.isArray(dimensionScores) || dimensionScores.length === 0) {
    console.error(`[Call2 ${assessmentId}] No dimension scores returned`);
    await supabase.from("assessments").update({ status: "failed" }).eq("id", assessmentId);
    return;
  }

  // ── Compute ARS in code (never Claude) ──────────────────────────────────
  const arsScore     = computeARS(dimensionScores);
  const band         = arsBand(arsScore);
  const personaScores = computePersonaScores(
    assessment.personas as Array<{ persona_id: string; display_label?: string; selected: boolean }>,
    dimensionScores
  );

  console.log(`[Call2 ${assessmentId}] ARS: ${arsScore} (${band})`);
  console.log(`[Call2 ${assessmentId}] Insights: ${insights?.length ?? 0}, Available: ${availableComponents?.length ?? 0}, Needed: ${neededComponents?.length ?? 0}`);

  // Store Call 2 results + computed ARS + insights + components
  await supabase
    .from("assessments")
    .update({
      dimension_scores:     dimensionScores,
      insights:             insights             ?? [],
      available_components: availableComponents  ?? [],
      needed_components:    neededComponents     ?? [],
      severity_counts:      severityCounts       ?? { Critical: 0, High: 0, Medium: 0 },
      evidence_records:     scoringResult.evidence,
      ars_score:            arsScore,
      ars_band:             band,
      persona_scores:       personaScores,
      framework_version:    "v1.0",
      status:               "draft",
    })
    .eq("id", assessmentId);

  // ── Trigger PDF generation in background immediately after ARS is stored ──
  import("../lib/reports").then(({ generateAndUploadPdf }) => {
    generateAndUploadPdf(assessmentId).catch(err => {
      console.error(`[PDF ${assessmentId}] Generation failed:`, err);
    });
  });

  console.log(`[Call2 ${assessmentId}] Complete — status: draft`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Call 4: Agent Interface Generation
// ─────────────────────────────────────────────────────────────────────────────

export async function runAgentInterface(
  assessmentId: string,
  _consultantId: string
): Promise<void> {
  console.log(`[Call4 ${assessmentId}] Starting agent interface generation`);

  // Fetch current assessment state
  const { data: assessment, error } = await supabase
    .from("assessments")
    .select("business_context, personas, final_component_list, website_url, client_name")
    .eq("id", assessmentId)
    .single();

  if (error || !assessment) {
    throw new Error(`Assessment ${assessmentId} not found`);
  }

  const interfaceSpec   = readPromptSpec("RAXIS_Prompt4_Interface.md");
  const confirmedPersonas = (assessment.personas as Array<{ persona_id: string; selected: boolean }>)
    .filter(p => p.selected);

  const interfaceSystem = `You are the RAXIS Agent Interface generator, operating under RAXIS Framework v1.0.
The full specification is in the <spec> block of the user message and is the governing
authority for every requirement and output field. Follow it exactly.

You output ONLY valid JSON. No text before or after the JSON. No markdown code fences
around the outer JSON. The string values inside the JSON may contain markdown.

YOUR TASK
From the Final Component List and the business context, generate two markdown strings:
(a) agents.md — a structured markdown document with YAML frontmatter
(b) llms.txt — a community-convention markdown file`;

  const interfaceUser = `<spec>
${interfaceSpec}
</spec>

<business_context>
${JSON.stringify(assessment.business_context)}
</business_context>

<confirmed_personas>
${JSON.stringify(confirmedPersonas)}
</confirmed_personas>

<final_component_list>
${JSON.stringify(assessment.final_component_list)}
</final_component_list>

Return only the JSON described in the system message.`;

  let interfaceResult: Record<string, unknown>;
  try {
    const raw        = await callClaude(interfaceSystem, interfaceUser, 0.6, 16000);
    interfaceResult  = safeParseJSON(raw);
  } catch (err) {
    console.error(`[Call4 ${assessmentId}] Failed:`, err);
    await supabase.from("assessments").update({ status: "failed" }).eq("id", assessmentId);
    return;
  }

  // Validate — agents.md must start with YAML frontmatter
  const bundle   = interfaceResult.agent_interface_bundle as Record<string, unknown> ?? interfaceResult;
  const agentsMd = bundle.companion_file_agents_md as string ?? "";
  const llmsTxt  = bundle.llms_txt as string ?? "";

  if (!agentsMd.startsWith("---")) {
    console.error(`[Call4 ${assessmentId}] agents.md missing YAML frontmatter`);
    // Still store what we got — don't fail the whole assessment
  }

  // Credential scan — basic pattern check
  const credentialPattern = /sk-[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9]{20,}/g;
  const safeAgentsMd = agentsMd.replace(credentialPattern, "[REDACTED — credential must be provided out of band]");
  const safeLlmsTxt  = llmsTxt.replace(credentialPattern,  "[REDACTED — credential must be provided out of band]");

  const finalBundle = {
    spec_version:               "v1.0",
    framework_version:          "v1.0",
    generated_for_url:          assessment.website_url,
    generated_at:               new Date().toISOString(),
    companion_file_agents_md:   safeAgentsMd,
    llms_txt:                   safeLlmsTxt,
  };

  // Store and mark completed
  await supabase
    .from("assessments")
    .update({
      agent_interface_bundle: finalBundle,
      status:                 "completed",
    })
    .eq("id", assessmentId);

  // ── Generate and upload ZIP immediately ──────────────────────────────────
  const { generateAndUploadZip } = await import("../lib/reports");
  await generateAndUploadZip(assessmentId).catch(err => {
    console.error(`[ZIP ${assessmentId}] Generation failed:`, err);
  });

  console.log(`[Call4 ${assessmentId}] Complete — assessment completed`);
}
