import { NextRequest, NextResponse } from "next/server";
import { isCloudStorageConfigured } from "@/lib/server/supabase";
import { kvGet, kvSet } from "@/lib/server/kv-store";
import { runAiScraper } from "@/lib/server/brightdata-scraper";
import {
  getBrandTerms,
  getCompetitorTerms,
  findMentions,
  detectSentiment,
  calcVisibilityScore,
} from "@/lib/server/scoring";
import type { AppState, Provider, ScrapeRun } from "@/components/dashboard/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow long-running scrape jobs (Vercel Pro supports up to 300 s)
export const maxDuration = 300;

function storageKeyForWorkspace(wsId: string) {
  return wsId === "default" ? "sovereign-aeo-tracker-v1" : `sovereign-aeo-tracker-${wsId}`;
}

/**
 * POST /api/cron
 *
 * Automated scraping endpoint designed to be called by an external scheduler
 * (e.g. a cron job, Vercel Cron, or GitHub Actions workflow).
 *
 * Requirements:
 *   - Cloud sync must be configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   - If CRON_SECRET is set, the request must include
 *     `Authorization: Bearer <CRON_SECRET>`
 *
 * Query params:
 *   - workspace (optional): workspace ID to run against (default: "default")
 *
 * The handler reads the full app state from cloud KV storage, runs every
 * configured prompt × provider combination via the Bright Data scraper,
 * enriches each result with visibility scoring, and saves the updated runs
 * back to cloud storage — mirroring what the UI does through /api/scrape.
 */
export async function POST(req: NextRequest) {
  if (!isCloudStorageConfigured()) {
    return NextResponse.json(
      {
        error:
          "Cloud sync is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use the cron endpoint.",
      },
      { status: 501 },
    );
  }

  // Optional bearer-token authentication
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const wsId = req.nextUrl.searchParams.get("workspace") ?? "default";
  const key = storageKeyForWorkspace(wsId);

  // Load persisted state from cloud
  const loadResult = await kvGet<AppState>(key);
  if (!loadResult.ok) {
    return NextResponse.json(
      { error: `Failed to load state: ${loadResult.error}` },
      { status: 500 },
    );
  }
  const state = loadResult.value;
  if (!state) {
    return NextResponse.json(
      {
        error:
          "No state found in cloud storage for this workspace. " +
          "Open the UI at least once to initialise the workspace.",
      },
      { status: 404 },
    );
  }

  // Determine prompts (replace {brand} placeholder) and providers
  const rawPrompts =
    state.customPrompts?.length > 0
      ? state.customPrompts.map((p) => p.text)
      : [state.prompt];
  const prompts = rawPrompts.map((t) =>
    t.replace(/\{brand\}/gi, state.brand.brandName || "our brand"),
  );
  const providers: Provider[] =
    state.activeProviders?.length > 0 ? state.activeProviders : [state.provider];

  if (prompts.length === 0 || providers.length === 0) {
    return NextResponse.json(
      { error: "No prompts or providers configured in the workspace." },
      { status: 400 },
    );
  }

  const brandTerms = getBrandTerms(state);
  const competitorTerms = getCompetitorTerms(state);

  const newRuns: ScrapeRun[] = [];
  const errors: string[] = [];

  for (const prompt of prompts) {
    for (const provider of providers) {
      try {
        const scraped = await runAiScraper({ provider, prompt, requireSources: true });
        const run: ScrapeRun = {
          provider: scraped.provider,
          prompt: scraped.prompt,
          answer: scraped.answer,
          sources: scraped.sources,
          createdAt: scraped.createdAt,
          visibilityScore: calcVisibilityScore(
            scraped.answer,
            scraped.sources,
            brandTerms,
            state.brand.websites ?? [],
          ),
          sentiment: detectSentiment(scraped.answer, brandTerms),
          brandMentions: findMentions(scraped.answer, brandTerms),
          competitorMentions: findMentions(scraped.answer, competitorTerms),
        };
        newRuns.push(run);
      } catch (err) {
        errors.push(
          `${provider} / ${prompt.slice(0, 60)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (newRuns.length > 0) {
    const updatedState: AppState = {
      ...state,
      runs: [...newRuns, ...(state.runs ?? [])].slice(0, 500),
      lastScheduledRun: new Date().toISOString(),
    };
    const saveResult = await kvSet(key, updatedState);
    if (!saveResult.ok) {
      return NextResponse.json(
        {
          error: `Scraping finished but failed to save state: ${saveResult.error}`,
          runs: newRuns.length,
          errors: errors.length > 0 ? errors : undefined,
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    workspace: wsId,
    runs: newRuns.length,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
