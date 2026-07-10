import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Firecrawl configuration
// ─────────────────────────────────────────────────────────────────────────────

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape";
const FIRECRAWL_TIMEOUT = 60_000; // 60 seconds

// ─────────────────────────────────────────────────────────────────────────────
// Helper: call Firecrawl API
// Returns the raw markdown snapshot of the page
// ─────────────────────────────────────────────────────────────────────────────

async function crawlWithFirecrawl(url: string): Promise<{
  markdown: string;
  metadata: Record<string, unknown>;
  links: string[];
}> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY environment variable");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT);

  try {
    const response = await fetch(FIRECRAWL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        onlyMainContent: false,
        waitFor: 2000, // Wait 2s for JS-rendered content
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Firecrawl API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as {
      success?: boolean;
      data?: {
        markdown?: string;
        metadata?: Record<string, unknown>;
        links?: string[];
      };
    };

    if (!data.success || !data.data) {
      throw new Error("Firecrawl returned no data");
    }

    return {
      markdown: data.data.markdown ?? "",
      metadata: data.data.metadata ?? {},
      links:    data.data.links    ?? [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build evidence records from the crawl snapshot
// These are preliminary evidence records before Claude processes the snapshot.
// Claude will build its own detailed evidence array in Call 1.
// These are stored alongside the snapshot for traceability.
// ─────────────────────────────────────────────────────────────────────────────

function buildPreliminaryEvidence(
  url: string,
  markdown: string,
  links: string[],
  metadata: Record<string, unknown>
): Array<Record<string, unknown>> {
  const evidence: Array<Record<string, unknown>> = [];
  let evIdx = 1;

  const evId = () => `pre_ev_${String(evIdx++).padStart(4, "0")}`;

  // Page title
  if (metadata.title) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "Page title",
      location:     url,
      observed:     metadata.title,
      captured_by:  "firecrawl",
      confidence:   "high",
    });
  }

  // Meta description
  if (metadata.description) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "Meta description",
      location:     url,
      observed:     metadata.description,
      captured_by:  "firecrawl",
      confidence:   "high",
    });
  }

  // Internal links count — signals navigation depth
  const internalLinks = links.filter(l => {
    try { return new URL(l).hostname === new URL(url).hostname; } catch { return false; }
  });
  evidence.push({
    evidence_id:  evId(),
    signal:       "Internal links discovered",
    location:     url,
    observed:     `${internalLinks.length} internal links found`,
    captured_by:  "firecrawl",
    confidence:   "high",
  });

  // Check for schema.org / JSON-LD markers in the markdown
  if (markdown.includes("application/ld+json") || markdown.includes("schema.org")) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "Schema.org / JSON-LD markup detected",
      location:     url,
      observed:     "Structured data markers present in page content",
      captured_by:  "firecrawl",
      confidence:   "medium",
    });
  }

  // Check for API / developer signals
  if (/api|developer|docs|swagger|openapi/i.test(markdown)) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "API or developer documentation signals",
      location:     url,
      observed:     "API/developer-related content detected in page markdown",
      captured_by:  "firecrawl",
      confidence:   "medium",
    });
  }

  // Check for pricing signals
  if (/pricing|price|plan|subscribe|per month|per year/i.test(markdown)) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "Pricing content signals",
      location:     url,
      observed:     "Pricing-related content detected in page markdown",
      captured_by:  "firecrawl",
      confidence:   "medium",
    });
  }

  // Check for login / auth walls
  if (/sign in|log in|login|sign up|register|create account/i.test(markdown)) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "Authentication / sign-in signals",
      location:     url,
      observed:     "Login or registration content detected",
      captured_by:  "firecrawl",
      confidence:   "medium",
    });
  }

  // Check for CAPTCHA signals
  if (/captcha|recaptcha|hcaptcha|cloudflare/i.test(markdown)) {
    evidence.push({
      evidence_id:  evId(),
      signal:       "CAPTCHA or bot-challenge signals",
      location:     url,
      observed:     "CAPTCHA or bot-protection content detected",
      captured_by:  "firecrawl",
      confidence:   "medium",
    });
  }

  return evidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/assessments/:id/crawl
//
// Triggered when consultant submits the URL Input screen (Screen 5).
// 1. Updates assessment with client_name and website_url
// 2. Sets status to "crawling"
// 3. Calls Firecrawl API to get the page snapshot
// 4. Stores frozen snapshot on the assessment record
// 5. Sets status to "personas_pending"
// 6. Triggers Claude Call 1 (Persona Suggestion) in the background
//
// The frontend navigates to the Persona Confirmation screen (Screen 6)
// immediately after this returns. Screen 6 polls GET /api/v1/assessments/:id
// until personas are available.
//
// Body: { clientName: string, url: string }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/crawl", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { clientName, url } = req.body;

  // ── Validate inputs ──────────────────────────────────────────────────────
  if (!clientName?.trim() || !url?.trim()) {
    res.status(400).json({ error: "clientName and url are required" });
    return;
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    res.status(400).json({ error: "URL must start with http:// or https://" });
    return;
  }

  // ── Confirm assessment belongs to this consultant ────────────────────────
  const { data: assessment, error: fetchError } = await supabase
    .from("assessments")
    .select("id, status")
    .eq("id", id)
    .eq("consultant_id", req.user!.id)
    .single();

  if (fetchError || !assessment) {
    res.status(404).json({ error: "Assessment not found" });
    return;
  }

  // ── Set status to crawling and save client info ──────────────────────────
  await supabase
    .from("assessments")
    .update({
      client_name: clientName.trim(),
      website_url: url.trim(),
      status:      "crawling",
    })
    .eq("id", id);

  // ── Respond immediately so the frontend can navigate to personas screen ──
  // The crawl and Call 1 run in the background
  res.status(202).json({ message: "Crawl started", assessmentId: id });

  // ── Background: crawl + Call 1 ───────────────────────────────────────────
  // Fire and forget — errors are stored on the assessment record
  runCrawlAndPersonas(id, url.trim(), clientName.trim(), req.user!.id).catch(err => {
    console.error(`Background crawl failed for assessment ${id}:`, err);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Background job: crawl the URL and run Claude Call 1
// ─────────────────────────────────────────────────────────────────────────────

async function runCrawlAndPersonas(
  assessmentId: string,
  url: string,
  clientName: string,
  consultantId: string
): Promise<void> {
  try {
    // ── Step 1: Crawl the URL ──────────────────────────────────────────────
    console.log(`[Crawl ${assessmentId}] Starting crawl of ${url}`);
    const { markdown, metadata, links } = await crawlWithFirecrawl(url);

    if (!markdown || markdown.length < 100) {
      throw new Error("Firecrawl returned insufficient content — page may be empty or blocked");
    }

    // ── Step 2: Build preliminary evidence records ─────────────────────────
    const preliminaryEvidence = buildPreliminaryEvidence(url, markdown, links, metadata);

    // ── Step 3: Store the frozen snapshot ─────────────────────────────────
    // This snapshot is NEVER updated after this point.
    // All Claude calls use this frozen version.
    const crawlSnapshot = {
      url,
      captured_at:  new Date().toISOString(),
      markdown,
      metadata,
      links:        links.slice(0, 200), // Cap at 200 links to control token usage
      word_count:   markdown.split(/\s+/).length,
    };

    await supabase
      .from("assessments")
      .update({
        crawl_snapshot:   crawlSnapshot,
        evidence_records: preliminaryEvidence,
      })
      .eq("id", assessmentId);

    console.log(`[Crawl ${assessmentId}] Snapshot stored. Word count: ${crawlSnapshot.word_count}`);

    // ── Step 4: Trigger Claude Call 1 (Persona Suggestion) ────────────────
    // Import and call the Claude pipeline
    // This is imported here to avoid circular dependencies
    const { runPersonaSuggestion } = await import("./pipeline");
    await runPersonaSuggestion(assessmentId, clientName, url, crawlSnapshot, consultantId);

  } catch (err) {
    // Store the error on the assessment record so the frontend can surface it
    console.error(`[Crawl ${assessmentId}] Failed:`, err);
    await supabase
      .from("assessments")
      .update({ status: "failed" })
      .eq("id", assessmentId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/assessments/:id/confirm-personas
//
// Called when the consultant clicks "Confirm & Run Audit" on Screen 6.
// 1. Saves the consultant's persona selections
// 2. Runs the dimension selection engine (pure code)
// 3. Triggers Claude Call 2 (Scoring + Findings) in the background
//
// The frontend navigates to the Loading screen (Screen 7) immediately.
// Screen 8 (Scorecard) polls GET /api/v1/assessments/:id/scorecard
// until the ARS data is ready.
//
// Body: { personas: [{ persona_id: string, selected: boolean }] }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/confirm-personas", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { personas } = req.body;

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!Array.isArray(personas) || personas.length === 0) {
    res.status(400).json({ error: "personas array is required" });
    return;
  }

  // At least one persona must be selected
  const selectedPersonas = personas.filter((p: { selected: boolean }) => p.selected);
  if (selectedPersonas.length === 0) {
    res.status(400).json({ error: "At least one persona must be selected" });
    return;
  }

  // ── Fetch the current assessment ─────────────────────────────────────────
  const { data: assessment, error: fetchError } = await supabase
    .from("assessments")
    .select("id, status, personas, business_context, crawl_snapshot")
    .eq("id", id)
    .eq("consultant_id", req.user!.id)
    .single();

  if (fetchError || !assessment) {
    res.status(404).json({ error: "Assessment not found" });
    return;
  }

  if (!assessment.crawl_snapshot) {
    res.status(409).json({ error: "Crawl not complete yet — please wait" });
    return;
  }

  // ── Merge consultant selections into the stored personas array ───────────
  const currentPersonas = (assessment.personas as Array<Record<string, unknown>>) ?? [];
  const updatedPersonas = currentPersonas.map(p => ({
    ...p,
    selected: personas.find(
      (x: { persona_id: string; selected: boolean }) => x.persona_id === p.persona_id
    )?.selected ?? p.selected,
  }));

  // ── Save updated personas and set status to auditing ─────────────────────
  await supabase
    .from("assessments")
    .update({
      personas: updatedPersonas,
      status:   "auditing",
    })
    .eq("id", id);

  // ── Respond immediately ───────────────────────────────────────────────────
  res.status(202).json({ message: "Audit started", assessmentId: id });

  // ── Background: run Claude Calls 2, 3 ────────────────────────────────────
  runScoringPipeline(id, req.user!.id).catch(err => {
    console.error(`Background scoring failed for assessment ${id}:`, err);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Background job: run Claude Calls 2 and 3
// ─────────────────────────────────────────────────────────────────────────────

async function runScoringPipeline(assessmentId: string, consultantId: string): Promise<void> {
  try {
    const { runScoringAndComponents } = await import("./pipeline");
    await runScoringAndComponents(assessmentId, consultantId);
  } catch (err) {
    console.error(`[Scoring ${assessmentId}] Failed:`, err);
    await supabase
      .from("assessments")
      .update({ status: "failed" })
      .eq("id", assessmentId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/assessments/:id/generate-interface
//
// Called when the consultant clicks "Generate Interface" on Screen 12.
// Triggers Claude Call 4 (Agent Interface Generation) in the background.
// The frontend navigates to the Output screen (Screen 13) and polls
// GET /api/v1/assessments/:id until agent_interface_bundle is populated.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/generate-interface", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // ── Fetch the assessment ──────────────────────────────────────────────────
  const { data: assessment, error: fetchError } = await supabase
    .from("assessments")
    .select("id, status, final_component_list, business_context, personas")
    .eq("id", id)
    .eq("consultant_id", req.user!.id)
    .single();

  if (fetchError || !assessment) {
    res.status(404).json({ error: "Assessment not found" });
    return;
  }

  if (!assessment.final_component_list) {
    res.status(409).json({ error: "Final component list not ready — complete the builder first" });
    return;
  }

  // ── Respond immediately ───────────────────────────────────────────────────
  res.status(202).json({ message: "Interface generation started", assessmentId: id });

  // ── Background: run Claude Call 4 ────────────────────────────────────────
  runInterfaceGeneration(id, req.user!.id).catch(err => {
    console.error(`Background interface generation failed for assessment ${id}:`, err);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Background job: run Claude Call 4
// ─────────────────────────────────────────────────────────────────────────────

async function runInterfaceGeneration(assessmentId: string, consultantId: string): Promise<void> {
  try {
    const { runAgentInterface } = await import("./pipeline");
    await runAgentInterface(assessmentId, consultantId);
  } catch (err) {
    console.error(`[Interface ${assessmentId}] Failed:`, err);
    await supabase
      .from("assessments")
      .update({ status: "failed" })
      .eq("id", assessmentId);
  }
}

export default router;
