import { Router, type Request, type Response } from "express";
import { supabaseAnon, supabase } from "../lib/supabase";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// Cookie configuration
const COOKIE_NAME = "raxis_token";
const COOKIE_OPTIONS = {
  httpOnly: true,       // Not accessible from JavaScript — protects against XSS
  secure: process.env.NODE_ENV === "production",  // HTTPS only in production
  sameSite: "lax" as const,
  maxAge: 8 * 60 * 60 * 1000, // 8 hours in milliseconds — matches FR-AUTH-05
  path: "/",
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/login
//
// Accepts email + password.
// Validates against Supabase Auth.
// Sets httpOnly cookie with the access token.
// Returns consultant profile.
//
// FR-AUTH-01, FR-AUTH-02
// ─────────────────────────────────────────────────────────────────────────────

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Basic input validation
    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    // Trim whitespace (handles copy-paste with spaces — FR-AUTH-01 edge case)
    const cleanEmail = email.trim().toLowerCase();

    // Domain check — belt-and-suspenders on top of the DB trigger
    if (!cleanEmail.endsWith("@robosoftin.com")) {
      // Return same generic error as wrong password — don't reveal domain policy
      res.status(401).json({ error: "Invalid Credentials" });
      return;
    }

    // Authenticate with Supabase
    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (error || !data.session || !data.user) {
      // Supabase returns various error messages — normalise to one message
      // so we never leak whether the email exists (FR-AUTH-01 edge case)
      res.status(401).json({ error: "Invalid Credentials" });
      return;
    }

    // Fetch consultant profile from public.users
    const { data: profile } = await supabase
      .from("users")
      .select("id, email, display_name, role")
      .eq("id", data.user.id)
      .single();

    // Set httpOnly cookie with the Supabase access token
    res.cookie(COOKIE_NAME, data.session.access_token, COOKIE_OPTIONS);

    // Return profile to frontend
    res.status(200).json({
      user: {
        id: data.user.id,
        email: data.user.email,
        display_name: profile?.display_name ?? data.user.email?.split("@")[0],
        role: profile?.role ?? "consultant",
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login service unavailable. Please try again later." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auth/me
//
// Returns the current consultant's profile from their cookie session.
// Used by the frontend to check if a user is logged in on page load.
//
// FR-AUTH-01, FR-AUTH-03
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    // req.user is set by requireAuth middleware
    const { data: profile, error } = await supabase
      .from("users")
      .select("id, email, display_name, role")
      .eq("id", req.user!.id)
      .single();

    if (error || !profile) {
      res.status(404).json({ error: "Consultant profile not found" });
      return;
    }

    res.status(200).json({
      user: {
        id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
        role: profile.role,
      },
    });
  } catch (err) {
    console.error("Get me error:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/logout
//
// Revokes the Supabase session server-side.
// Clears the httpOnly cookie.
//
// FR-AUTH-05 — logout must invalidate server-side, not just clear cookie
// ─────────────────────────────────────────────────────────────────────────────

router.post("/logout", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.cookies?.[COOKIE_NAME];

    if (token) {
      // Sign out from Supabase server-side — invalidates the token
      // so it cannot be reused even if someone has a copy of the cookie
      await supabaseAnon.auth.admin?.signOut(token).catch(() => {
        // If this fails, we still clear the cookie on the client side
        // Log but do not block logout
        console.warn("Supabase server-side signout failed — clearing cookie anyway");
      });
    }

    // Clear the cookie regardless
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(200).json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    // Always clear cookie even if something goes wrong — FR-AUTH-05 edge case
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(200).json({ message: "Logged out" });
  }
});

export default router;
