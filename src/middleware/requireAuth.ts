import type { Request, Response, NextFunction } from "express";
import { supabaseAnon } from "../lib/supabase";

// Extend Express Request to carry the verified user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// requireAuth middleware
//
// Reads the Supabase access token from the httpOnly cookie set at login.
// Verifies it against Supabase. Attaches user to req.user.
// Rejects with 401 if missing or invalid.
// ─────────────────────────────────────────────────────────────────────────────

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Read token from httpOnly cookie
    const token = req.cookies?.raxis_token;

    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Verify token with Supabase
    const { data, error } = await supabaseAnon.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    // Attach verified user to request
    req.user = {
      id: data.user.id,
      email: data.user.email ?? "",
    };

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ error: "Authentication check failed" });
  }
}
