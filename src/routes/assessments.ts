import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// All assessment routes require authentication
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: map a raw DB row to the ApiAssessmentRow shape the frontend expects
// Matches the ApiAssessmentRow interface in lib/types.ts
// ─────────────────────────────────────────────────────────────────────────────

function mapRowToApi(row: Record<string, unknown>) {
  return {
    id:           row.id,
    site:         row.website_url,
    url:          row.website_url,
    client:       row.client_name,
    client_name:  row.client_name,
    last_run:     row.updated_at,
    updated_at:   row.updated_at,
    created_at:   row.created_at,
    score:        row.ars_score ?? null,
    ars_score:    row.ars_score ?? null,
    status:       mapStatus(row.status as string),
    last_step:    deriveLastStep(row),
  };
}

// Map DB status ENUM to frontend display status
// Matches the mapStatus() function in lib/api.ts
function mapStatus(dbStatus: string): string {
  switch (dbStatus) {
    case "completed":           return "Completed";
    case "draft":               return "Draft";
    case "failed":              return "Failed";
    case "created":
    case "crawling":
    case "personas_pending":
    case "auditing":
    default:                    return "In Progress";
  }
}

// Derive the last step for Resume button routing
// Matches ROUTES.assessmentResume() in lib/routes.ts
function deriveLastStep(row: Record<string, unknown>): string {
  const status = row.status as string;

  // Terminal states
  if (status === "completed") return "output";
  if (status === "failed")    return "url";

  // Data-based checks for advanced steps (in case status wasn't updated)
  const hasBundle    = Boolean(row.agent_interface_bundle);
  const hasFinalList = Array.isArray(row.final_component_list)
    && (row.final_component_list as unknown[]).length > 0;
  const hasArs       = row.ars_score !== null && row.ars_score !== undefined;

  if (hasBundle)    return "output";
  if (hasFinalList) return "builder";
  if (hasArs)       return "scorecard";

  // Status-based checks for early steps
  // "personas_pending" means Call 1 done, consultant needs to confirm personas
  if (status === "personas_pending") return "personas";

  // "auditing" means Call 2 is running or just done — go to scorecard
  if (status === "auditing") return "scorecard";

  // Fallback — if URL is set but no personas yet, we're on URL step
  if (row.website_url) return "url";
  return "url";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/assessments
//
// Returns paginated list of assessments for the logged-in consultant.
// Used by DashboardScreen to populate the assessments table.
//
// Query params:
//   page  (number, default 1)
//   limit (number, default 8)
//
// Response shape matches AssessmentsListResponse in lib/types.ts:
//   { assessments: ApiAssessmentRow[], totalCount: number }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(20, parseInt(req.query.limit as string) || 8);
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    // Fetch paginated rows + total count in one query
    const { data, error, count } = await supabase
      .from("assessments")
      .select("id, client_name, website_url, status, ars_score, ars_band, personas, final_component_list, agent_interface_bundle, created_at, updated_at", { count: "exact" })
      .eq("consultant_id", req.user!.id)
      .order("updated_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("List assessments error:", error);
      res.status(500).json({ error: "Failed to fetch assessments" });
      return;
    }

    res.status(200).json({
      assessments: (data ?? []).map(mapRowToApi),
      totalCount:  count ?? 0,
    });
  } catch (err) {
    console.error("List assessments error:", err);
    res.status(500).json({ error: "Failed to fetch assessments" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/assessments
//
// Creates a new blank assessment record.
// Called when consultant clicks "Start a new assessment" on the Dashboard.
// Navigates to the URL Input screen (Screen 5) with the new ID.
//
// Response shape matches CreateAssessmentResponse in lib/types.ts:
//   { id: string }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from("assessments")
      .insert({
        consultant_id:     req.user!.id,
        client_name:       "Untitled",   // Placeholder — updated when consultant submits URL Input screen
        website_url:       "",            // Placeholder — updated on crawl trigger
        status:            "created",
        framework_version: "v1.0",
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Create assessment error:", error);
      res.status(500).json({ error: "Failed to create assessment" });
      return;
    }

    res.status(201).json({ id: data.id });
  } catch (err) {
    console.error("Create assessment error:", err);
    res.status(500).json({ error: "Failed to create assessment" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/assessments/:id
//
// Returns the full assessment detail object.
// Used by multiple screens to hydrate their state on load.
//
// Response shape matches AssessmentDetail in lib/types.ts
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("assessments")
      .select("*")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)   // RLS belt-and-suspenders — never serve another consultant's data
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Assessment not found" });
      return;
    }

    // Return the full shape — frontend picks what it needs per screen
    res.status(200).json({
      id:                     data.id,
      url:                    data.website_url,
      site:                   data.website_url,
      client_name:            data.client_name,
      domain:                 data.website_url,
      status:                 data.status,
      framework_version:      data.framework_version,
      // Call 1 outputs
      business_context:       data.business_context,
      personas:               data.personas,
      // Call 2 outputs
      dimension_scores:       data.dimension_scores,
      insights:               data.insights,
      available_components:   data.available_components,
      needed_components:      data.needed_components,
      severity_counts:        data.severity_counts,
      ars_score:              data.ars_score,
      ars_band:               data.ars_band,
      persona_scores:         data.persona_scores,
      // Call 3 outputs (legacy — kept for backwards compat)
      components:             data.components,
      // Builder output
      final_component_list:   data.final_component_list,
      // Call 4 outputs
      agent_interface_bundle: data.agent_interface_bundle,
      // Download URLs
      report_pdf_url:         data.report_pdf_url,
      report_zip_url:         data.report_zip_url,
      // Timestamps
      created_at:             data.created_at,
      updated_at:             data.updated_at,
    });
  } catch (err) {
    console.error("Get assessment error:", err);
    res.status(500).json({ error: "Failed to fetch assessment" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/assessments/:id
//
// Partial update — saves draft progress at any pipeline stage.
// Called by saveDraft() and patchAssessment() in lib/api.ts.
//
// Allowed fields to update:
//   client_name, website_url, status, personas, final_component_list
//
// Note: Claude pipeline outputs (dimension_scores, findings, etc.) are written
// by the pipeline routes directly, not by this endpoint. This endpoint is only
// for consultant-driven updates.
// ─────────────────────────────────────────────────────────────────────────────

router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Whitelist of fields the frontend is allowed to update via this endpoint
    const ALLOWED_FIELDS = [
      "client_name",
      "website_url",
      "status",
      "personas",
      "final_component_list",
    ];

    // Build update object from only allowed fields present in the request body
    const updates: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    // Confirm the assessment belongs to this consultant before updating
    // Also fetch current status to protect pipeline-managed states
    const { data: existing } = await supabase
      .from("assessments")
      .select("id, status, ars_score")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .single();

    if (!existing) {
      res.status(404).json({ error: "Assessment not found" });
      return;
    }

    // Status protection — don't let "draft" status overwrite pipeline states
    // If frontend sends status="draft" but current is "personas_pending" AND
    // ars_score is not yet computed, keep it as personas_pending (consultant
    // hasn't confirmed personas yet — Resume should return them to that step)
    if (updates.status === "draft"
        && existing.status === "personas_pending"
        && (existing.ars_score === null || existing.ars_score === undefined)) {
      delete updates.status;
    }

    const { data, error } = await supabase
      .from("assessments")
      .update(updates)
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("Patch assessment error:", error);
      res.status(500).json({ error: "Failed to update assessment" });
      return;
    }

    // Return the same shape as GET /:id so the frontend can update its state
    res.status(200).json({
      id:                     data.id,
      url:                    data.website_url,
      site:                   data.website_url,
      client_name:            data.client_name,
      status:                 data.status,
      personas:               data.personas,
      final_component_list:   data.final_component_list,
      agent_interface_bundle: data.agent_interface_bundle,
      updated_at:             data.updated_at,
    });
  } catch (err) {
    console.error("Patch assessment error:", err);
    res.status(500).json({ error: "Failed to update assessment" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/assessments/:id
//
// Soft delete — sets status to "failed" rather than removing the row.
// Hard delete is not exposed to the frontend to preserve audit history.
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Confirm ownership before deleting
    const { data: existing } = await supabase
      .from("assessments")
      .select("id")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .single();

    if (!existing) {
      res.status(404).json({ error: "Assessment not found" });
      return;
    }

    const { error } = await supabase
      .from("assessments")
      .delete()
      .eq("id", id)
      .eq("consultant_id", req.user!.id);

    if (error) {
      console.error("Delete assessment error:", error);
      res.status(500).json({ error: "Failed to delete assessment" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error("Delete assessment error:", err);
    res.status(500).json({ error: "Failed to delete assessment" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/assessments/:id/scorecard
//
// Returns the ARS scorecard data for Screen 8 (ARS Scorecard).
// Only returns data if the assessment status is auditing, draft, or completed.
// Returns 404 while the pipeline is still running — the frontend polls this.
//
// Response shape matches what mapScorecardResponse() in lib/api.ts expects:
//   { ars: { score, band, headline, dimension_scores, persona_scores, severity_counts }, findings }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/scorecard", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("assessments")
      .select("status, ars_score, ars_band, dimension_scores, persona_scores, severity_counts, findings, insights, available_components, needed_components, business_context")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Assessment not found" });
      return;
    }

    // Return 404 while pipeline is still running — frontend polls until it gets 200
    const readyStatuses = ["auditing", "draft", "completed"];
    if (!readyStatuses.includes(data.status) || !data.ars_score) {
      res.status(404).json({ error: "Scorecard not ready yet" });
      return;
    }

    // Derive headline from band
    const headlines: Record<string, string> = {
      excellent:  "This site is well prepared for AI agents.",
      good:       "This site is moderately ready, with clear opportunities.",
      needs_work: "Agents will frequently struggle with this site.",
      not_ready:  "Agents largely cannot use this site.",
    };

    res.status(200).json({
      ars: {
        score:            data.ars_score,
        band:             data.ars_band,
        headline:         headlines[data.ars_band] ?? "",
        dimension_scores: data.dimension_scores ?? [],
        persona_scores:   data.persona_scores ?? [],
        severity_counts:  data.severity_counts ?? { Critical: 0, High: 0, Medium: 0 },
      },
      insights:            data.insights            ?? [],
      available_components: data.available_components ?? [],
      needed_components:    data.needed_components    ?? [],
    });
  } catch (err) {
    console.error("Get scorecard error:", err);
    res.status(500).json({ error: "Failed to fetch scorecard" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/assessments/:id/components
//
// Returns the components assessment for Screen 9 (Components Assessment).
// Response shape matches ComponentsResponse in lib/types.ts:
//   { available: AvailableComponent[], needed: NeededComponent[] }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/components", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("assessments")
      .select("status, available_components, needed_components, components")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Assessment not found" });
      return;
    }

    // Use new split columns first, fall back to legacy components if they exist
    const available = data.available_components ?? data.components?.available ?? [];
    const needed    = data.needed_components    ?? data.components?.needed    ?? [];

    if (!available.length && !needed.length) {
      res.status(404).json({ error: "Components not ready yet" });
      return;
    }

    res.status(200).json({ available, needed });
  } catch (err) {
    console.error("Get components error:", err);
    res.status(500).json({ error: "Failed to fetch components" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/assessments/:id/report/pdf
// GET /api/v1/assessments/:id/report/zip
//
// Returns the signed S3 URLs for PDF and ZIP downloads.
// Response shape matches SignedUrlResponse in lib/types.ts:
//   { url: string }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/report/pdf", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("assessments")
      .select("report_pdf_url")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .single();

    if (error || !data || !data.report_pdf_url) {
      res.status(404).json({ error: "PDF not ready yet" });
      return;
    }

    res.status(200).json({ url: data.report_pdf_url });
  } catch (err) {
    console.error("Get PDF URL error:", err);
    res.status(500).json({ error: "Failed to fetch PDF URL" });
  }
});

router.get("/:id/report/zip", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("assessments")
      .select("report_zip_url")
      .eq("id", id)
      .eq("consultant_id", req.user!.id)
      .single();

    if (error || !data || !data.report_zip_url) {
      res.status(404).json({ error: "ZIP not ready yet" });
      return;
    }

    res.status(200).json({ url: data.report_zip_url });
  } catch (err) {
    console.error("Get ZIP URL error:", err);
    res.status(500).json({ error: "Failed to fetch ZIP URL" });
  }
});

export default router;
