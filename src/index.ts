import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth";
import assessmentRoutes from "./routes/assessments";
import crawlRoutes from "./routes/crawl";

const app = express();
const PORT = process.env.PORT ?? 3001;

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

// CORS — allow requests from the Next.js frontend with cookies
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true, // Required for httpOnly cookies to work cross-origin
  })
);

// Parse JSON request bodies
app.use(express.json());

// Parse cookies (needed to read the raxis_token cookie)
app.use(cookieParser());

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Health check — used by Vercel and the team to confirm the server is running
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "raxis-backend", version: "1.0.0" });
});

// Auth routes: login, me, logout
app.use("/api/v1/auth", authRoutes);

// Assessment routes: CRUD + scorecard + components + downloads
app.use("/api/v1/assessments", assessmentRoutes);

// Crawl + pipeline trigger routes: crawl, confirm-personas, generate-interface
app.use("/api/v1/assessments", crawlRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// More routes will be added here as we build them:
//
// import crawlRoutes from "./routes/crawl";
// app.use("/api/v1/assessments", crawlRoutes);
// ─────────────────────────────────────────────────────────────────────────────

// 404 handler — catches any route not matched above
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`RAXIS backend running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export default app;
