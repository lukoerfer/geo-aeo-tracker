import type { AppState } from "@/components/dashboard/types";

/**
 * Server-side scoring utilities mirroring the client-side logic in
 * sovereign-dashboard.tsx so the /api/cron endpoint can compute the same
 * visibility scores without importing any client-only code.
 */

export function getBrandTerms(state: AppState): string[] {
  const terms: string[] = [];
  if (state.brand.brandName?.trim()) terms.push(state.brand.brandName.trim());
  if (state.brand.brandAliases?.trim()) {
    state.brand.brandAliases.split(",").forEach((a) => {
      const t = a.trim();
      if (t) terms.push(t);
    });
  }
  return terms;
}

export function getCompetitorTerms(state: AppState): string[] {
  return state.competitors.flatMap((c) => [c.name, ...c.aliases]).filter(Boolean);
}

export function findMentions(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t.toLowerCase()));
}

export function detectSentiment(
  answer: string,
  brandTerms: string[],
): "positive" | "neutral" | "negative" | "not-mentioned" {
  if (brandTerms.length === 0) return "not-mentioned";
  const lower = answer.toLowerCase();
  const mentioned = brandTerms.some((t) => lower.includes(t.toLowerCase()));
  if (!mentioned) return "not-mentioned";

  const positiveWords = [
    "best", "leading", "top", "excellent", "recommend", "great", "outstanding",
    "innovative", "trusted", "powerful", "superior", "preferred", "popular",
    "reliable", "impressive", "standout", "strong", "ideal",
  ];
  const negativeWords = [
    "worst", "poor", "bad", "avoid", "lacking", "weak", "inferior",
    "disappointing", "overpriced", "limited", "outdated", "risky",
    "problematic", "concern", "drawback", "downside",
  ];

  let posScore = 0;
  let negScore = 0;
  positiveWords.forEach((w) => { if (lower.includes(w)) posScore++; });
  negativeWords.forEach((w) => { if (lower.includes(w)) negScore++; });

  if (posScore > negScore + 1) return "positive";
  if (negScore > posScore + 1) return "negative";
  return "neutral";
}

export function calcVisibilityScore(
  answer: string,
  sources: string[],
  brandTerms: string[],
  brandWebsites: string[],
): number {
  if (brandTerms.length === 0) return 0;
  const lower = answer.toLowerCase();
  const mentioned = brandTerms.some((t) => lower.includes(t.toLowerCase()));
  if (!mentioned) return 0;

  let score = 30;

  const first200 = lower.slice(0, 200);
  if (brandTerms.some((t) => first200.includes(t.toLowerCase()))) score += 20;

  const brandRegexes = brandTerms.map(
    (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
  );
  const mentionCount = brandRegexes.reduce((acc, re) => acc + (lower.match(re)?.length ?? 0), 0);
  if (mentionCount >= 3) score += 15;
  else if (mentionCount >= 2) score += 8;

  const websiteDomains = (brandWebsites ?? [])
    .map((w) => w.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase())
    .filter(Boolean);
  if (
    websiteDomains.length > 0 &&
    sources.some((s) => {
      const sl = s.toLowerCase();
      return websiteDomains.some((d) => sl.includes(d));
    })
  ) {
    score += 20;
  }

  const sent = detectSentiment(answer, brandTerms);
  if (sent === "positive") score += 15;
  else if (sent === "neutral") score += 5;

  return Math.min(100, score);
}
