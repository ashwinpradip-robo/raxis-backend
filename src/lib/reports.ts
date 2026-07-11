// ─────────────────────────────────────────────────────────────────────────────
// RAXIS Report Generation v2.0
// Follows RAXIS_Report_Contents_Specification.docx exactly.
// 7 sections: Cover, Headline, Business Context, Personas, Dimensions,
//              Insights, Recommendations
// Font: Segoe UI / Noto Sans · Colours: Navy #07174E + Red #C41B46
// ─────────────────────────────────────────────────────────────────────────────

import puppeteer from "puppeteer";
import archiver from "archiver";
import { supabase } from "./supabase";

// ── Helper: band anchor for dimension scores per spec Section 5 ───────────────
function dimensionBand(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Exemplary", color: "#0F7C4D" };
  if (score >= 70) return { label: "Strong",    color: "#3C8C00" };
  if (score >= 50) return { label: "Workable",  color: "#D98A1F" };
  if (score >= 30) return { label: "Impaired",  color: "#C41B46" };
  return              { label: "Blocking",  color: "#7C0F1F" };
}

function arsBandInfo(score: number | null): { label: string; verdict: string; color: string } {
  const s = score ?? 0;
  if (s >= 80) return { label: "Excellent",  verdict: "This site is highly ready for AI agents.", color: "#0F7C4D" };
  if (s >= 60) return { label: "Good",       verdict: "This site is moderately ready for AI agents, with clear opportunities to improve.", color: "#3C8C00" };
  if (s >= 40) return { label: "Needs Work", verdict: "This site has significant readiness gaps and requires targeted improvements before agents can rely on it.", color: "#D98A1F" };
  return              { label: "Not Ready", verdict: "This site is not yet ready for AI agents and needs substantial work across most dimensions.", color: "#C41B46" };
}

const PRIORITY_COLORS: Record<string, string> = {
  Critical: "#C41B46",
  High:     "#D98A1F",
  Medium:   "#3C8C00",
};

// ─────────────────────────────────────────────────────────────────────────────
// Build PDF HTML — all 7 sections per specification
// ─────────────────────────────────────────────────────────────────────────────

interface PdfData {
  clientName:       string;
  websiteUrl:       string;
  assessmentId:     string;
  frameworkVersion: string;
  generatedAt:      string;
  // Section 2
  arsScore:         number | null;
  // Section 3
  businessContext:  Record<string, unknown>;
  // Section 4
  personas:         Array<Record<string, unknown>>;
  // Section 5
  dimensionScores:  Array<Record<string, unknown>>;
  // Section 6
  insights:         Array<Record<string, unknown>>;
  // Section 7
  neededComponents: Array<Record<string, unknown>>;
}

function buildPdfHtml(d: PdfData): string {
  const ars     = arsBandInfo(d.arsScore);
  const dateStr = new Date(d.generatedAt).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });

  // ── SECTION 3 helpers ──────────────────────────────────────────────────
  const bc         = d.businessContext ?? {};
  const archetype  = (bc.archetype_primary as string) ?? (bc.archetype as string) ?? "—";
  const model      = (bc.business_model   as string) ?? (bc.model as string) ?? "—";
  const primaryAct = (bc.primary_action_surface as string) ?? "—";
  const audience   = (bc.audience         as string) ?? "—";

  // ── SECTION 4 helpers ──────────────────────────────────────────────────
  const confirmed = (d.personas ?? []).filter(p => p.selected !== false);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: 'Segoe UI', 'Noto Sans', system-ui, sans-serif;
    color: #16181D;
    background: #fff;
    font-size: 11px;
    line-height: 1.5;
  }

  /* Page container — A4 210×297mm */
  .page {
    width: 210mm; min-height: 297mm;
    padding: 20mm 18mm 15mm;
    page-break-after: always;
    position: relative;
    background: #fff;
  }
  .page:last-child { page-break-after: auto; }

  /* Header/Footer */
  .page-header {
    position: absolute; top: 8mm; left: 18mm; right: 18mm;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 9px; color: #8A93A3;
    padding-bottom: 6px; border-bottom: 1px solid #E2E6EC;
  }
  .brand { font-weight: 800; color: #C41B46; font-size: 12px; letter-spacing: 0.02em; }
  .page-footer {
    position: absolute; bottom: 8mm; left: 18mm; right: 18mm;
    display: flex; justify-content: space-between;
    font-size: 8.5px; color: #8A93A3;
    border-top: 1px solid #E2E6EC; padding-top: 5px;
  }

  /* Section heading */
  h1.report-title {
    font-size: 28px; font-weight: 800; color: #07174E;
    margin: 40mm 0 8px; line-height: 1.15;
  }
  .subtitle { font-size: 13px; color: #525A68; margin-bottom: 30px; }

  .section-num {
    display: inline-block; width: 26px; height: 26px;
    border-radius: 50%; background: #C41B46; color: #fff;
    font-weight: 800; font-size: 12px;
    text-align: center; line-height: 26px;
    margin-right: 10px;
  }
  h2.section-heading {
    font-size: 15px; font-weight: 800; color: #07174E;
    margin: 26px 0 12px; display: flex; align-items: center;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  h2.section-heading:first-child { margin-top: 0; }

  h3.subsection {
    font-size: 12px; font-weight: 700; color: #16181D;
    margin: 16px 0 8px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }

  /* Cover — big centered ARS card */
  .cover-content {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 100mm; margin-top: 20mm;
  }
  .cover-meta {
    background: #F6F6F6; border-radius: 12px; padding: 20px 28px;
    width: 100%; margin-top: 24px;
    font-size: 11px; color: #525A68;
  }
  .cover-meta-row { display: flex; justify-content: space-between; padding: 6px 0; }
  .cover-meta-row strong { color: #16181D; font-weight: 700; }

  /* ARS hero card */
  .ars-hero {
    background: linear-gradient(135deg, #07174E 0%, #0D2A7A 100%);
    color: #fff; border-radius: 16px;
    padding: 26px 32px; margin-bottom: 22px;
    display: flex; align-items: center; gap: 26px;
  }
  .ars-hero-score {
    font-size: 62px; font-weight: 800; line-height: 1;
    color: #fff; flex-shrink: 0;
  }
  .ars-hero-score span { font-size: 22px; color: #D84468; margin-left: 4px; }
  .ars-hero-info { flex: 1; }
  .ars-hero-label { font-size: 10px; color: #D84468; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 800; }
  .ars-hero-band {
    display: inline-block; margin-top: 6px; padding: 5px 14px;
    background: rgba(255,255,255,0.18); border-radius: 999px;
    font-size: 11px; font-weight: 800; letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .ars-hero-verdict { font-size: 12px; color: rgba(255,255,255,0.85); margin-top: 12px; line-height: 1.5; }

  /* Business Context grid */
  .bc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
  .bc-card {
    background: #F6F6F6; border-left: 3px solid #C41B46;
    border-radius: 8px; padding: 12px 14px;
  }
  .bc-label { font-size: 9px; color: #8A93A3; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .bc-value { font-size: 13px; color: #16181D; font-weight: 700; margin-top: 4px; }

  /* Persona cards */
  .persona-card {
    background: #F6F6F6; border-radius: 10px;
    padding: 12px 16px; margin-bottom: 10px;
  }
  .persona-label { font-size: 12px; font-weight: 800; color: #07174E; margin-bottom: 4px; }
  .persona-field { margin-top: 6px; }
  .persona-tag { font-size: 8.5px; font-weight: 800; color: #8A93A3; letter-spacing: 0.3px; text-transform: uppercase; }
  .persona-just { font-size: 10.5px; color: #525A68; line-height: 1.5; margin-top: 1px; }

  /* Dimension table */
  .dim-table {
    width: 100%; border-collapse: collapse; margin-bottom: 10px;
    font-size: 10.5px;
  }
  .dim-table th {
    background: #07174E; color: #fff; padding: 8px 10px;
    text-align: left; font-weight: 700; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .dim-table td {
    padding: 9px 10px; border-bottom: 1px solid #E2E6EC;
    vertical-align: middle;
  }
  .dim-score {
    display: inline-block; font-weight: 800; font-size: 13px; color: #16181D;
  }
  .dim-bar-wrap { width: 90px; height: 6px; background: #E2E6EC; border-radius: 999px; overflow: hidden; display: inline-block; margin-left: 6px; vertical-align: middle; }
  .dim-bar-fill { height: 100%; background: #C41B46; border-radius: 999px; }
  .dim-band-badge {
    display: inline-block; padding: 3px 8px; border-radius: 999px;
    font-size: 9px; font-weight: 800; color: #fff;
    text-transform: uppercase; letter-spacing: 0.04em;
  }

  /* Insights */
  .insight-card {
    border: 1px solid #E2E6EC; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 12px;
    background: #fff;
  }
  .insight-dim { font-size: 9.5px; color: #C41B46; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .insight-title { font-size: 13px; font-weight: 800; color: #07174E; margin-bottom: 6px; }
  .insight-desc { font-size: 10.5px; color: #525A68; line-height: 1.55; margin-bottom: 10px; }
  .sg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .sg-box { padding: 10px 12px; border-radius: 8px; }
  .sg-strengths { background: rgba(31,157,107,0.07); border: 1px solid rgba(31,157,107,0.22); }
  .sg-gaps      { background: rgba(196,27,70,0.07); border: 1px solid rgba(196,27,70,0.22); }
  .sg-heading   { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .sg-strengths .sg-heading { color: #0F7C4D; }
  .sg-gaps .sg-heading      { color: #C41B46; }
  .sg-item { font-size: 10px; color: #16181D; margin-bottom: 4px; padding-left: 12px; position: relative; line-height: 1.4; }
  .sg-item::before {
    position: absolute; left: 0; top: 0; font-weight: 800;
  }
  .sg-strengths .sg-item::before { content: "✓"; color: #0F7C4D; }
  .sg-gaps .sg-item::before      { content: "✗"; color: #C41B46; }

  /* Recommendations */
  .rec-card {
    border-left: 4px solid #E2E6EC;
    background: #F6F6F6; border-radius: 8px;
    padding: 12px 16px; margin-bottom: 10px;
  }
  .rec-card.critical { border-left-color: #C41B46; }
  .rec-card.high     { border-left-color: #D98A1F; }
  .rec-card.medium   { border-left-color: #3C8C00; }
  .rec-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .rec-priority {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 9px; font-weight: 800; color: #fff;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .rec-title { font-size: 12.5px; font-weight: 700; color: #07174E; }
  .rec-benefit { font-size: 10.5px; color: #525A68; margin-bottom: 4px; line-height: 1.5; }
  .rec-personas { font-size: 9.5px; color: #8A93A3; font-style: italic; }
  .rec-solves { font-size: 10px; color: #16181D; margin-top: 4px; }
  .rec-solves strong { color: #C41B46; font-weight: 700; }
</style>
</head>
<body>

<!-- ═══════════════════════ PAGE 1 — COVER ═══════════════════════ -->
<div class="page">
  <div class="page-header">
    <span class="brand">RAXIS</span>
    <span>Agent Readiness Assessment Report</span>
  </div>

  <div class="cover-content">
    <h1 class="report-title">Agent Readiness<br/>Assessment Report</h1>
    <div class="subtitle">Prepared for ${escapeHtml(d.clientName)}</div>

    <div class="cover-meta">
      <div class="cover-meta-row"><span>Client</span><strong>${escapeHtml(d.clientName)}</strong></div>
      <div class="cover-meta-row"><span>Website</span><strong>${escapeHtml(d.websiteUrl)}</strong></div>
      <div class="cover-meta-row"><span>Assessment Date</span><strong>${dateStr}</strong></div>
      <div class="cover-meta-row"><span>Assessment ID</span><strong>${escapeHtml(d.assessmentId)}</strong></div>
      <div class="cover-meta-row"><span>Framework Version</span><strong>${escapeHtml(d.frameworkVersion)}</strong></div>
    </div>
  </div>

  <div class="page-footer">
    <span>RAXIS · Agent Readiness Assessment</span>
    <span>Page 1</span>
  </div>
</div>

<!-- ═══════════════════════ PAGE 2 — HEADLINE + BUSINESS CONTEXT + PERSONAS ═══════════════════════ -->
<div class="page">
  <div class="page-header">
    <span class="brand">RAXIS</span>
    <span>${escapeHtml(d.clientName)} · ${escapeHtml(d.websiteUrl)}</span>
  </div>

  <h2 class="section-heading"><span class="section-num">2</span>Headline Result — Agent Readiness Score</h2>

  <div class="ars-hero">
    <div class="ars-hero-score">${d.arsScore ?? 0}<span>/100</span></div>
    <div class="ars-hero-info">
      <div class="ars-hero-label">Agent Readiness Score</div>
      <div class="ars-hero-band" style="background: ${ars.color}">${ars.label.toUpperCase()}</div>
      <div class="ars-hero-verdict">${ars.verdict}</div>
    </div>
  </div>

  <h2 class="section-heading"><span class="section-num">3</span>Business Context</h2>

  <div class="bc-grid">
    <div class="bc-card">
      <div class="bc-label">Archetype</div>
      <div class="bc-value">${escapeHtml(archetype)}</div>
    </div>
    <div class="bc-card">
      <div class="bc-label">Business Model</div>
      <div class="bc-value">${escapeHtml(model)}</div>
    </div>
    <div class="bc-card">
      <div class="bc-label">Primary Action Surface</div>
      <div class="bc-value">${escapeHtml(primaryAct)}</div>
    </div>
    <div class="bc-card">
      <div class="bc-label">Audience</div>
      <div class="bc-value">${escapeHtml(audience)}</div>
    </div>
  </div>

  <h2 class="section-heading"><span class="section-num">4</span>Personas Audited</h2>

  ${confirmed.map(p => `
    <div class="persona-card">
      <div class="persona-label">${escapeHtml((p.display_label as string) ?? (p.catalog_persona as string) ?? (p.persona_id as string) ?? "—")}</div>
      ${p.persona_definition ? `
      <div class="persona-field">
        <div class="persona-tag">What it is</div>
        <div class="persona-just">${escapeHtml(p.persona_definition as string)}</div>
      </div>` : ""}
      <div class="persona-field">
        <div class="persona-tag">Relevance</div>
        <div class="persona-just">${escapeHtml((p.justification as string) ?? (p.relevance as string) ?? "—")}</div>
      </div>
    </div>
  `).join("")}

  <div class="page-footer">
    <span>RAXIS · Agent Readiness Assessment</span>
    <span>Page 2</span>
  </div>
</div>

<!-- ═══════════════════════ PAGE 3 — DIMENSION BREAKDOWN ═══════════════════════ -->
<div class="page">
  <div class="page-header">
    <span class="brand">RAXIS</span>
    <span>${escapeHtml(d.clientName)} · ${escapeHtml(d.websiteUrl)}</span>
  </div>

  <h2 class="section-heading"><span class="section-num">5</span>Dimension Breakdown</h2>

  <p style="font-size: 10.5px; color: #525A68; margin-bottom: 14px; line-height: 1.5;">
    How the site scored on each readiness dimension selected for this assessment.
    Band anchors: Exemplary 90–100, Strong 70–89, Workable 50–69, Impaired 30–49, Blocking 0–29.
  </p>

  <table class="dim-table">
    <thead>
      <tr>
        <th style="width: 40%">Dimension</th>
        <th style="width: 25%">Score</th>
        <th style="width: 20%">Band</th>
        <th style="width: 15%">Weight</th>
      </tr>
    </thead>
    <tbody>
      ${d.dimensionScores.map(dim => {
        const score = (dim.score as number) ?? 0;
        const band  = dimensionBand(score);
        return `
        <tr>
          <td style="font-weight: 700; color: #16181D;">${escapeHtml((dim.name as string) ?? "")}</td>
          <td>
            <span class="dim-score">${score}</span>
            <div class="dim-bar-wrap"><div class="dim-bar-fill" style="width: ${score}%"></div></div>
          </td>
          <td><span class="dim-band-badge" style="background: ${band.color}">${band.label}</span></td>
          <td style="color: #525A68;">${(dim.weight as number) ?? 0}%</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>

  <div class="page-footer">
    <span>RAXIS · Agent Readiness Assessment</span>
    <span>Page 3</span>
  </div>
</div>

<!-- ═══════════════════════ PAGE 4+ — INSIGHTS (one per page or grouped) ═══════════════════════ -->
${d.insights.map((ins, idx) => `
<div class="page">
  <div class="page-header">
    <span class="brand">RAXIS</span>
    <span>${escapeHtml(d.clientName)} · ${escapeHtml(d.websiteUrl)}</span>
  </div>

  ${idx === 0 ? `<h2 class="section-heading"><span class="section-num">6</span>Insights</h2>` : ""}

  <div class="insight-card">
    <div class="insight-dim">${escapeHtml((ins.dimension_name as string) ?? (ins.dimension_id as string) ?? "")}</div>
    <div class="insight-title">${escapeHtml((ins.insight_title as string) ?? "")}</div>
    <div class="insight-desc">${escapeHtml((ins.description as string) ?? "")}</div>

    <div class="sg-grid">
      <div class="sg-box sg-strengths">
        <div class="sg-heading">Strengths</div>
        ${((ins.strengths as string[]) ?? []).map(s => `<div class="sg-item">${escapeHtml(s)}</div>`).join("")}
      </div>
      <div class="sg-box sg-gaps">
        <div class="sg-heading">Gaps</div>
        ${((ins.gaps as string[]) ?? []).map(g => `<div class="sg-item">${escapeHtml(g)}</div>`).join("")}
      </div>
    </div>
  </div>

  <div class="page-footer">
    <span>RAXIS · Agent Readiness Assessment</span>
    <span>Page ${4 + idx}</span>
  </div>
</div>
`).join("")}

<!-- ═══════════════════════ RECOMMENDATIONS ═══════════════════════ -->
<div class="page">
  <div class="page-header">
    <span class="brand">RAXIS</span>
    <span>${escapeHtml(d.clientName)} · ${escapeHtml(d.websiteUrl)}</span>
  </div>

  <h2 class="section-heading"><span class="section-num">7</span>Recommendations</h2>

  <p style="font-size: 10.5px; color: #525A68; margin-bottom: 14px; line-height: 1.5;">
    High-level components to collect and build in order to make this site agent-ready.
    Priority derived from the severity of the underlying finding.
  </p>

  ${d.neededComponents.map(rec => {
    const priority = (rec.priority as string) ?? "Medium";
    const priorityClass = priority.toLowerCase();
    const color = PRIORITY_COLORS[priority] ?? "#8A93A3";
    const personas = Array.isArray(rec.personas) ? (rec.personas as string[]).join(", ") : ((rec.personas as string) ?? "—");
    return `
    <div class="rec-card ${priorityClass}">
      <div class="rec-header">
        <span class="rec-priority" style="background: ${color}">${priority.toUpperCase()}</span>
        <span class="rec-title">${escapeHtml((rec.title as string) ?? "")}</span>
      </div>
      <div class="rec-benefit">${escapeHtml((rec.projected_benefit as string) ?? "")}</div>
      <div class="rec-solves">${escapeHtml((rec.why_recommended as string) ?? "")}</div>
      <div class="rec-personas" style="margin-top: 4px;">Personas: ${escapeHtml(personas)}</div>
    </div>`;
  }).join("")}

  <div class="page-footer">
    <span>RAXIS · Agent Readiness Assessment</span>
    <span>Page ${4 + d.insights.length}</span>
  </div>
</div>

</body>
</html>`;
}

function escapeHtml(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate PDF buffer via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────

async function generatePdfBuffer(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    // In Docker (Render), use pre-installed Chromium via PUPPETEER_EXECUTABLE_PATH env var
    // In local dev, fall back to Puppeteer's bundled Chromium
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate and upload PDF to Supabase Storage
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAndUploadPdf(assessmentId: string): Promise<void> {
  console.log(`[PDF ${assessmentId}] Starting PDF generation`);

  // Fetch assessment
  const { data, error } = await supabase
    .from("assessments")
    .select("*")
    .eq("id", assessmentId)
    .single();

  if (error || !data) {
    console.error(`[PDF ${assessmentId}] Failed to fetch assessment:`, error);
    return;
  }

  const html = buildPdfHtml({
    clientName:       data.client_name ?? "Client",
    websiteUrl:       data.website_url ?? data.url ?? "—",
    assessmentId,
    frameworkVersion: data.framework_version ?? "v1.0",
    generatedAt:      data.updated_at ?? new Date().toISOString(),
    arsScore:         data.ars_score,
    businessContext:  data.business_context ?? {},
    personas:         data.personas ?? [],
    dimensionScores:  data.dimension_scores ?? [],
    insights:         data.insights ?? [],
    neededComponents: data.needed_components ?? [],
  });

  const pdfBuffer = await generatePdfBuffer(html);

  // Upload to Supabase Storage
  const clientSlug = (data.client_name ?? "client")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `RAXIS-ARS-Report-${clientSlug}-${assessmentId.slice(0, 8)}.pdf`;
  const storagePath = `${assessmentId}/${filename}`;

  const { error: uploadErr } = await supabase.storage
    .from("raxis-reports")
    .upload(storagePath, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadErr) {
    console.error(`[PDF ${assessmentId}] Upload failed:`, uploadErr);
    return;
  }

  // Get signed URL
  const { data: signed } = await supabase.storage
    .from("raxis-reports")
    .createSignedUrl(storagePath, 3600);

  await supabase
    .from("assessments")
    .update({ report_pdf_url: signed?.signedUrl ?? null })
    .eq("id", assessmentId);

  console.log(`[PDF ${assessmentId}] Complete — uploaded to Supabase Storage`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate and upload ZIP (agents.md + llms.txt) — unchanged
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAndUploadZip(assessmentId: string): Promise<void> {
  console.log(`[ZIP ${assessmentId}] Starting ZIP generation`);

  const { data, error } = await supabase
    .from("assessments")
    .select("client_name, agent_interface_bundle")
    .eq("id", assessmentId)
    .single();

  if (error || !data || !data.agent_interface_bundle) {
    console.error(`[ZIP ${assessmentId}] Missing agent_interface_bundle`);
    return;
  }

  const bundle = data.agent_interface_bundle as Record<string, string>;
  const agentsMd = bundle.companion_file_agents_md ?? "";
  const llmsTxt  = bundle.llms_txt ?? "";

  // Build ZIP using a proper Promise-based stream collection
  const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end",  () => resolve(Buffer.concat(chunks)));
    archive.on("error", (err) => reject(err));

    archive.append(agentsMd, { name: "agents.md" });
    archive.append(llmsTxt,  { name: "llms.txt" });
    archive.finalize();
  });

  const clientSlug = (data.client_name ?? "client")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `RAXIS-Agent-Interface-${clientSlug}-${assessmentId.slice(0, 8)}.zip`;
  const storagePath = `${assessmentId}/${filename}`;

  const { error: uploadErr } = await supabase.storage
    .from("raxis-reports")
    .upload(storagePath, zipBuffer, {
      contentType: "application/zip",
      upsert: true,
    });

  if (uploadErr) {
    console.error(`[ZIP ${assessmentId}] Upload failed:`, uploadErr);
    return;
  }

  const { data: signed } = await supabase.storage
    .from("raxis-reports")
    .createSignedUrl(storagePath, 3600);

  await supabase
    .from("assessments")
    .update({ report_zip_url: signed?.signedUrl ?? null })
    .eq("id", assessmentId);

  console.log(`[ZIP ${assessmentId}] Complete — uploaded to Supabase Storage`);
}
