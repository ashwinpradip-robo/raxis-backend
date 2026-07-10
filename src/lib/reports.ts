// ─────────────────────────────────────────────────────────────────────────────
// RAXIS — PDF and ZIP Generation
// Generates the 4-page ARS Report PDF and the agent files ZIP.
// Uploads both to Supabase Storage (raxis-reports bucket).
// Called by the pipeline after Call 2 completes (PDF) and Call 4 completes (ZIP).
//
// PDF pages:
//   Page 1 — Cover: Company, ARS Score, Dimension Scores
//   Page 2 — Persona Breakdown + Severity Counts + Top Findings Overview
//   Page 3 — Detailed Findings with Business Impact
//   Page 4 — Parameter Definitions + Finding Priority Rationale
//
// ZIP contents:
//   agents.md  — from agent_interface_bundle
//   llms.txt   — from agent_interface_bundle
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "../lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Supabase Storage upload helper
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET = "raxis-reports";
const SIGNED_URL_EXPIRY = 60 * 60; // 1 hour in seconds

async function uploadToSupabase(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(filename, buffer, {
      contentType,
      upsert: true, // Overwrite if re-generating
    });

  if (uploadError) {
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(filename, SIGNED_URL_EXPIRY);

  if (signedError || !signedData?.signedUrl) {
    throw new Error(`Failed to create signed URL: ${signedError?.message}`);
  }

  return signedData.signedUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML template for PDF rendering
// Puppeteer renders this HTML to a 4-page PDF.
// Matches the layout of the uploaded RAXIS-ARS-Report-hubspot_com.pdf mockup.
// ─────────────────────────────────────────────────────────────────────────────

function buildPdfHtml(data: {
  clientName:      string;
  websiteUrl:      string;
  assessmentId:    string;
  arsScore:        number;
  arsBand:         string;
  dimensionScores: Array<{ name: string; score: number; weight: number }>;
  personaScores:   Array<{ display_label: string; score: number; band: string }>;
  severityCounts:  { Critical: number; High: number; Medium: number };
  findings:        Array<{
    severity: string;
    title: string;
    personas: string | string[];
    dimension_id?: string;
    business_impact: string;
    description?: string;
    priority_reason?: string;
    maps_to_component?: string;
  }>;
  dimensionScoresFull: Array<{
    name: string;
    score: number;
    weight: number;
    description?: string;
  }>;
}): string {
  const {
    clientName, websiteUrl, assessmentId, arsScore, arsBand,
    dimensionScores, personaScores, severityCounts, findings,
    dimensionScoresFull,
  } = data;

  const bandLabel: Record<string, string> = {
    excellent:  "EXCELLENT",
    good:       "GOOD",
    needs_work: "NEEDS WORK",
    not_ready:  "NOT READY",
  };

  const bandColor: Record<string, string> = {
    excellent:  "#15803d",
    good:       "#1d4ed8",
    needs_work: "#c2610c",
    not_ready:  "#b91c1c",
  };

  const sevColor: Record<string, string> = {
    Critical: "#C41B46",
    High:     "#D98A1F",
    Medium:   "#3C8C00",
  };

  const hostname = (() => {
    try { return new URL(websiteUrl).hostname; } catch { return websiteUrl; }
  })();

  const personasStr = (p: string | string[]) =>
    Array.isArray(p) ? p.join(" · ") : p;

  // Dimension descriptions (fallback if not provided by Claude)
  const dimDescriptions: Record<string, string> = {
    "Data Accessibility and Extractability":
      "Measures whether product, pricing, and policy data is exposed in a machine-readable form rather than locked in images or client-side-only rendering.",
    "Structured Data and Semantics":
      "Evaluates the presence and accuracy of schema.org / JSON-LD markup that lets agents extract entities without heuristic scraping.",
    "Content Structure and Navigation Semantics":
      "Assesses semantic HTML structure — heading hierarchy, landmark regions, and consistent page templates.",
    "Action Enablement":
      "Checks whether key conversion actions can be completed by an agent without CAPTCHAs or JavaScript-only flows.",
    "Navigation Clarity and Discoverability":
      "Reviews sitemap completeness, internal linking, and URL predictability so agents can discover relevant pages.",
    "API and Programmatic Access":
      "Looks for documented, authenticated API endpoints that let integration agents call functionality programmatically.",
    "Authentication and Access Barriers":
      "Assesses how well the site documents and facilitates authenticated access for agents.",
    "Content Freshness and Reliability Signals":
      "Evaluates signals that help agents determine if content is current and trustworthy.",
    "Trust, Verification and Safety Signals":
      "Checks for signals that allow agents to verify the legitimacy of actions and data.",
    "Bot Policy and Rate Limiting":
      "Reviews the site's bot policy, robots.txt, and rate limiting for agent compatibility.",
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #16181D;
    background: #fff;
  }
  .page {
    width: 794px;
    min-height: 1123px;
    padding: 48px 52px;
    page-break-after: always;
    position: relative;
  }
  .page:last-child { page-break-after: avoid; }

  /* Header bar */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 28px;
    padding-bottom: 16px;
    border-bottom: 2px solid #C41B46;
  }
  .brand { font-size: 22px; font-weight: 800; color: #C41B46; letter-spacing: 2px; }
  .page-title { font-size: 13px; color: #525A68; text-align: right; }
  .client-name { font-size: 15px; font-weight: 700; color: #16181D; }

  /* ARS Score block */
  .ars-block {
    background: #07174E;
    border-radius: 16px;
    padding: 32px 36px;
    margin-bottom: 28px;
    display: flex;
    align-items: center;
    gap: 36px;
  }
  .ars-score {
    font-size: 72px;
    font-weight: 800;
    color: #fff;
    line-height: 1;
    flex-shrink: 0;
  }
  .ars-score span { font-size: 28px; font-weight: 400; opacity: 0.6; }
  .ars-right { flex: 1; }
  .ars-band {
    display: inline-block;
    padding: 5px 14px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .ars-headline { font-size: 15px; color: rgba(255,255,255,0.85); line-height: 1.5; }

  /* Section heading */
  .section-heading {
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8A93A3;
    margin-bottom: 12px;
  }

  /* Dimension scores table */
  .dim-table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
  .dim-table th {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #8A93A3;
    padding: 8px 12px;
    text-align: left;
    background: #F6F6F6;
    border-bottom: 1px solid #E2E6EC;
  }
  .dim-table td {
    padding: 10px 12px;
    font-size: 13px;
    border-bottom: 1px solid #E2E6EC;
    vertical-align: middle;
  }
  .score-bar-bg {
    background: #E2E6EC;
    border-radius: 999px;
    height: 6px;
    width: 120px;
    display: inline-block;
    vertical-align: middle;
    margin-right: 8px;
  }
  .score-bar-fill {
    background: #C41B46;
    border-radius: 999px;
    height: 6px;
    display: inline-block;
  }

  /* Severity badges */
  .sev-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
  }

  /* Finding card */
  .finding-card {
    border: 1px solid #E2E6EC;
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 12px;
  }
  .finding-title { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
  .finding-meta { font-size: 11px; color: #8A93A3; margin-bottom: 8px; }
  .finding-impact { font-size: 13px; color: #525A68; line-height: 1.5; }

  /* Footer */
  .page-footer {
    position: absolute;
    bottom: 28px;
    left: 52px;
    right: 52px;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: #8A93A3;
    border-top: 1px solid #E2E6EC;
    padding-top: 10px;
  }

  /* Persona row */
  .persona-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid #E2E6EC;
    font-size: 13px;
  }

  /* Severity counts grid */
  .sev-grid {
    display: flex;
    gap: 16px;
    margin-bottom: 28px;
  }
  .sev-cell {
    flex: 1;
    border: 1px solid #E2E6EC;
    border-radius: 10px;
    padding: 16px;
    text-align: center;
  }
  .sev-count { font-size: 36px; font-weight: 800; }
  .sev-label { font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 4px; }

  /* Parameter definition */
  .param-row {
    padding: 12px 0;
    border-bottom: 1px solid #E2E6EC;
  }
  .param-name { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .param-desc { font-size: 12px; color: #525A68; line-height: 1.5; }
</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════════════ PAGE 1: Cover + Scorecard -->
<div class="page">
  <div class="header">
    <div>
      <div class="brand">RAXIS</div>
      <div style="font-size:11px;color:#8A93A3;margin-top:2px;">Agent Readiness Score Report</div>
    </div>
    <div class="page-title">
      <div class="client-name">${clientName}</div>
      <div style="margin-top:2px;">${hostname}</div>
      <div style="margin-top:2px;font-size:11px;">Assessment ID: ${assessmentId}</div>
    </div>
  </div>

  <!-- ARS Score -->
  <div class="ars-block">
    <div class="ars-score">${arsScore}<span>/100</span></div>
    <div class="ars-right">
      <div class="ars-band" style="background:${bandColor[arsBand] ?? "#1d4ed8"};color:#fff;">
        ${bandLabel[arsBand] ?? arsBand.toUpperCase()}
      </div>
      <div class="ars-headline">
        ${{
          excellent:  "This site is well prepared for AI agents.",
          good:       "This site is moderately ready for AI agents.",
          needs_work: "Agents will frequently struggle with this site.",
          not_ready:  "Agents largely cannot use this site.",
        }[arsBand] ?? ""}
      </div>
    </div>
  </div>

  <!-- Dimension Scores -->
  <div class="section-heading">Dimension Scores</div>
  <table class="dim-table">
    <thead>
      <tr>
        <th>Dimension</th>
        <th>Score</th>
        <th>Weight</th>
      </tr>
    </thead>
    <tbody>
      ${dimensionScores.map(d => `
      <tr>
        <td style="font-weight:600;">${d.name}</td>
        <td>
          <span class="score-bar-bg">
            <span class="score-bar-fill" style="width:${d.score * 1.2}px;"></span>
          </span>
          <strong>${d.score}/100</strong>
        </td>
        <td style="color:#8A93A3;">${d.weight}%</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <div class="page-footer">
    <span>Generated by RAXIS — AI Agent Readiness Audit System</span>
    <span>Page 1 of 4</span>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════ PAGE 2: Persona + Severity + Findings Overview -->
<div class="page">
  <div class="header">
    <div>
      <div class="brand">RAXIS</div>
      <div style="font-size:11px;color:#8A93A3;margin-top:2px;">Persona &amp; Severity Breakdown</div>
    </div>
    <div class="page-title">
      <div class="client-name">${clientName}</div>
      <div style="margin-top:2px;">${hostname}</div>
    </div>
  </div>

  <!-- Per-Persona ARS -->
  <div class="section-heading">Per-Persona ARS Breakdown</div>
  <div style="border:1px solid #E2E6EC;border-radius:10px;overflow:hidden;margin-bottom:28px;">
    <div style="display:flex;justify-content:space-between;padding:8px 14px;background:#F6F6F6;">
      <span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#8A93A3;">Persona</span>
      <span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#8A93A3;">Score / Band</span>
    </div>
    ${personaScores.map(p => `
    <div class="persona-row">
      <span style="font-weight:600;">${p.display_label}</span>
      <span><strong>${p.score}/100</strong> <span style="color:#8A93A3;font-size:11px;">${p.band.replace("_"," ").toUpperCase()}</span></span>
    </div>`).join("")}
  </div>

  <!-- Severity Counts -->
  <div class="section-heading">Severity Counts</div>
  <div class="sev-grid">
    <div class="sev-cell">
      <div class="sev-count" style="color:#C41B46;">${severityCounts.Critical}</div>
      <div class="sev-label" style="color:#C41B46;">Critical</div>
    </div>
    <div class="sev-cell">
      <div class="sev-count" style="color:#D98A1F;">${severityCounts.High}</div>
      <div class="sev-label" style="color:#D98A1F;">High</div>
    </div>
    <div class="sev-cell">
      <div class="sev-count" style="color:#3C8C00;">${severityCounts.Medium}</div>
      <div class="sev-label" style="color:#3C8C00;">Medium</div>
    </div>
  </div>

  <!-- Findings Overview -->
  <div class="section-heading">Findings Overview</div>
  <table class="dim-table">
    <thead>
      <tr>
        <th>Severity</th>
        <th>Finding</th>
        <th>Personas</th>
        <th>Dimension</th>
      </tr>
    </thead>
    <tbody>
      ${findings.slice(0, 6).map(f => `
      <tr>
        <td><span class="sev-badge" style="background:${sevColor[f.severity] ?? "#8A93A3"};">${f.severity}</span></td>
        <td style="font-size:12px;">${f.title}</td>
        <td style="font-size:11px;color:#8A93A3;">${personasStr(f.personas)}</td>
        <td style="font-size:11px;color:#8A93A3;">${(f as any).dimension_id ?? (f as any).dimension ?? ""}</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <div class="page-footer">
    <span>Generated by RAXIS — AI Agent Readiness Audit System</span>
    <span>Page 2 of 4</span>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════ PAGE 3: Detailed Findings -->
<div class="page">
  <div class="header">
    <div>
      <div class="brand">RAXIS</div>
      <div style="font-size:11px;color:#8A93A3;margin-top:2px;">Detailed Findings</div>
    </div>
    <div class="page-title">
      <div class="client-name">${clientName}</div>
      <div style="margin-top:2px;">${hostname}</div>
    </div>
  </div>

  <div class="section-heading">Detailed Findings</div>
  ${findings.map(f => `
  <div class="finding-card">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <span class="sev-badge" style="background:${sevColor[f.severity] ?? "#8A93A3"};">${f.severity}</span>
      <span class="finding-title" style="margin:0;">${f.title}</span>
    </div>
    <div class="finding-meta">
    Personas: ${personasStr(f.personas)} &nbsp;·&nbsp; Dimension: ${(f as any).dimension_id ?? (f as any).dimension ?? (f as any).dimension ?? ""}
    </div>
    <div class="finding-impact">${f.business_impact}</div>
  </div>`).join("")}

  <div class="page-footer">
    <span>Generated by RAXIS — AI Agent Readiness Audit System</span>
    <span>Page 3 of 4</span>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════ PAGE 4: Parameter Definitions + Priority Rationale -->
<div class="page">
  <div class="header">
    <div>
      <div class="brand">RAXIS</div>
      <div style="font-size:11px;color:#8A93A3;margin-top:2px;">Detailed Description</div>
    </div>
    <div class="page-title">
      <div class="client-name">${clientName}</div>
      <div style="margin-top:2px;">${hostname}</div>
    </div>
  </div>

  <!-- Parameter Definitions -->
  <div class="section-heading">Parameter Definitions</div>
  <div style="margin-bottom:28px;">
    ${dimensionScoresFull.map(d => `
    <div class="param-row">
      <div class="param-name">${d.name}</div>
      <div class="param-desc">${d.description ?? dimDescriptions[d.name] ?? ""}</div>
    </div>`).join("")}
  </div>

  <!-- Finding Priority Rationale -->
  <div class="section-heading">Finding Details &amp; Priority Rationale</div>
  ${findings.filter(f => f.description || f.priority_reason).map(f => `
  <div class="finding-card">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <span class="sev-badge" style="background:${sevColor[f.severity] ?? "#8A93A3"};">${f.severity}</span>
      <span class="finding-title" style="margin:0;">${f.title}</span>
    </div>
    ${f.description ? `<div class="finding-impact" style="margin-bottom:8px;">${f.description}</div>` : ""}
    ${f.priority_reason ? `
    <div style="background:#F6F6F6;border-radius:6px;padding:10px 12px;font-size:12px;color:#525A68;line-height:1.5;">
      <strong>Priority rationale:</strong> ${f.priority_reason}
    </div>` : ""}
  </div>`).join("")}

  <div class="page-footer">
    <span>Generated by RAXIS — AI Agent Readiness Audit System</span>
    <span>Page 4 of 4</span>
  </div>
</div>

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate PDF using Puppeteer
// ─────────────────────────────────────────────────────────────────────────────

async function generatePdfBuffer(html: string): Promise<Buffer> {
  // Dynamic import — puppeteer is only loaded when needed
  const puppeteer = await import("puppeteer");
  const browser   = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format:            "A4",
      printBackground:   true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate ZIP buffer containing agents.md and llms.txt
// ─────────────────────────────────────────────────────────────────────────────

async function generateZipBuffer(
  agentsMd: string,
  llmsTxt: string,
  clientSlug: string
): Promise<Buffer> {
  // Dynamic import
  const archiver = await import("archiver");
  const { Writable } = await import("stream");

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });

    writable.on("finish", () => resolve(Buffer.concat(chunks)));
    writable.on("error",  reject);

    const archive = archiver.default("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    archive.pipe(writable);

    archive.append(agentsMd, { name: "agents.md" });
    archive.append(llmsTxt,  { name: "llms.txt" });
    archive.finalize();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: generateAndUploadPdf
// Called by pipeline.ts immediately after Call 2 + ARS computation
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAndUploadPdf(assessmentId: string): Promise<void> {
  console.log(`[PDF ${assessmentId}] Starting PDF generation`);

  // Fetch all data needed for the PDF from the database
  const { data, error } = await supabase
    .from("assessments")
    .select([
      "client_name",
      "website_url",
      "ars_score",
      "ars_band",
      "dimension_scores",
      "persona_scores",
      "severity_counts",
      "findings",
    ].join(", "))
    .eq("id", assessmentId)
    .single();

  if (error || !data) {
    throw new Error(`Assessment ${assessmentId} not found for PDF generation`);
  }

  const html = buildPdfHtml({
    clientName:          data.client_name,
    websiteUrl:          data.website_url,
    assessmentId,
    arsScore:            data.ars_score,
    arsBand:             data.ars_band,
    dimensionScores:     data.dimension_scores ?? [],
    personaScores:       data.persona_scores   ?? [],
    severityCounts:      data.severity_counts  ?? { Critical: 0, High: 0, Medium: 0 },
    findings:            data.findings         ?? [],
    dimensionScoresFull: data.dimension_scores ?? [],
  });

  const pdfBuffer = await generatePdfBuffer(html);

  const clientSlug = data.client_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const filename  = `${assessmentId}/raxis-${clientSlug}-report.pdf`;
  const signedUrl = await uploadToSupabase(pdfBuffer, filename, "application/pdf");

  // Store the signed URL on the assessment record
  await supabase
    .from("assessments")
    .update({ report_pdf_url: signedUrl })
    .eq("id", assessmentId);

  console.log(`[PDF ${assessmentId}] Complete — uploaded to Supabase Storage`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export: generateAndUploadZip
// Called by pipeline.ts immediately after Call 4 completes
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAndUploadZip(assessmentId: string): Promise<void> {
  console.log(`[ZIP ${assessmentId}] Starting ZIP generation`);

  const { data, error } = await supabase
    .from("assessments")
    .select("client_name, agent_interface_bundle")
    .eq("id", assessmentId)
    .single();

  if (error || !data || !data.agent_interface_bundle) {
    throw new Error(`Assessment ${assessmentId} has no agent interface bundle`);
  }

  const bundle   = data.agent_interface_bundle as Record<string, string>;
  const agentsMd = bundle.companion_file_agents_md ?? "";
  const llmsTxt  = bundle.llms_txt ?? "";

  const clientSlug = data.client_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const zipBuffer = await generateZipBuffer(agentsMd, llmsTxt, clientSlug);
  const filename  = `${assessmentId}/raxis-${clientSlug}-agent-files.zip`;
  const signedUrl = await uploadToSupabase(zipBuffer, filename, "application/zip");

  await supabase
    .from("assessments")
    .update({ report_zip_url: signedUrl })
    .eq("id", assessmentId);

  console.log(`[ZIP ${assessmentId}] Complete — uploaded to Supabase Storage`);
}
