import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { z } from "zod";

const bodySchema = z.object({ password: z.string() });

/**
 * POST /api/auth
 *
 * Verifies an edit-mode password against the server-side EDIT_PASSWORD env var.
 * Returns { ok: true } on success or 401 on mismatch.
 *
 * When EDIT_PASSWORD is not set the endpoint always returns { ok: true } so
 * deployments without a password configured stay fully editable.
 */
export async function POST(req: NextRequest) {
  const editPassword = process.env.EDIT_PASSWORD;

  // No password configured → edit mode is always open
  if (!editPassword) {
    return NextResponse.json({ ok: true });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing password field." }, { status: 400 });
  }

  // Use constant-time comparison to prevent timing attacks
  const expected = Buffer.from(editPassword, "utf8");
  const provided = Buffer.from(parsed.data.password, "utf8");
  const match =
    expected.length === provided.length && timingSafeEqual(expected, provided);

  if (!match) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
