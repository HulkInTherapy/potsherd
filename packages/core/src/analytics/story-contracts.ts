/**
 * "Wrapped" story contract (slopie 1.8): `snapshot.launch.story`.
 *
 * Everything here is computed locally from a per-prompt feature table. Text
 * never leaves the machine unless the user is online and acknowledges the
 * recipient notice; even then only aggregated numbers and at most eight
 * already-filtered short quotes are sent (see `enrichment`).
 *
 * Private vs public: `publicAuditSnapshot` keeps only `StoryCard.public`
 * wording, drops quotes, project names and typed lines. Fields documented as
 * "private" are null/empty in the public snapshot.
 */
import type {AuditHarness} from './contracts.js';

export const STORY_VERSION = 'story-v1';

/** Where a prompt came from. `claude_hist` = Claude session known only from ~/.claude/history.jsonl. */
export type StoryHarness = 'claude' | 'claude_hist' | 'codex' | 'pi' | 'opencode';

export interface StoryChartPoint {
  /** Category or ordinal: '2026-03', 'Mon', 13, 'gpt-6-sol', ... */
  x: string | number;
  y: number;
  /** Optional per-point caption (already safe to display). */
  label?: string;
}
export interface StorySeries {name: string; points: readonly StoryChartPoint[]}
export type StoryChartType =
  | 'line' | 'bar' | 'hbar' | 'histogram' | 'slope' | 'balance' | 'clock24' | 'heatmap7x24' | 'calendar'
  | 'tally' | 'bubbles' | 'sparkline' | 'stacked_area' | 'two_bubbles' | 'big_number' | 'words' | 'keyboard' | 'autocomplete' | 'grid';
export interface StoryChart {
  type: StoryChartType;
  /** Visual metaphor suggested by the insights catalog: 'receipt', 'fuse', 'ecg_flatline', 'tombstones', ... */
  motif?: string;
  series: readonly StorySeries[];
  /** The x value to spotlight (tipping month, the expensive bucket, the angriest hour...). */
  highlight?: string | number | null;
  xLabel?: string;
  yLabel?: string;
  /** Unit of y: 'prompts', 'pct', 'usd', 'words', 'per100', 'subagents', 'seconds', 'ratio'. */
  unit?: string;
}

export type StoryCardKind = 'money' | 'mood' | 'model' | 'habit' | 'language' | 'time' | 'project' | 'growth' | 'trivia';

/** Spec section (V18-EXPERIENCE-SPEC card order) a card belongs to. */
export type StorySection =
  | 'cold_open' | 'scale' | 'bill' | 'clock' | 'models' | 'best_worst' | 'mood' | 'fuse' | 'talk' | 'manners'
  | 'projects' | 'delegation' | 'first_latest' | 'archetype' | 'awards' | 'more';

export interface StoryCard {
  /** Stable detector id, e.g. 'most_expensive_sentence', 'mood_drift', 'worst_model'. */
  id: string;
  kind: StoryCardKind;
  /** Spec card this belongs to; several cards can share a section (UI shows the best-ranked first). */
  section: StorySection;
  /** Private wording; may contain a masked quote, a project name or a typed line. */
  headline: string;
  support: string;
  /** Raw numbers behind the wording (rates are percentages 0..100 unless the key says otherwise). */
  numbers: Readonly<Record<string, number | string | boolean | null>>;
  chart: StoryChart;
  /** Only from fixed slots; ≤90 chars, single line, swears masked, secrets/paths/sensitive topics rejected. Private. */
  quote?: string | null;
  /** 0..1: how far the evidence clears the detector's guard. */
  confidence: number;
  /** Base wow 0..100 from the catalog. */
  wow: number;
  /** How far the claim is from the user's own baseline (≥1; e.g. 10 for '×10'). */
  surprise: number;
  /** Ranking score = wow × confidence × log-surprise bonus; cards are sorted by it. */
  score: number;
  /** 1-based position after ranking. */
  rank: number;
  /** Number-only wording for the public snapshot / share card; null hides the card publicly. */
  public: {headline: string; support: string} | null;
}

export interface StoryModelMood {
  model: string;
  /** Display label, e.g. 'GPT-6 Sol', 'Opus 4.5'. */
  label: string;
  /** Prompts answered by this model (observed in transcripts only). */
  prompts: number;
  swearPer100: number;
  praisePer100: number;
  /** Month-matched expectation: what the other models got from you in the same months (null without peers). */
  expectedSwearPer100: number | null;
  expectedPraisePer100: number | null;
  /** (observed+1)/(expected+1) over month-matched cells; null when not comparable. */
  swearRatio: number | null;
  praiseRatio: number | null;
  /** Months in which this model had ≥15 prompts and ≥15 peer prompts. */
  matchedMonths: number;
}

export interface StoryProject {
  id: string;
  alias: string;
  /** Private: directory basename. */
  name: string | null;
  prompts: number;
  costUsd: number;
  /** Null under 10 priced prompts. */
  costPerPrompt: number | null;
  firstDay: string;
  lastDay: string;
  activeDays: number;
  /** Days between this project's last prompt and the newest prompt overall. */
  idleDays: number;
}

export type StoryRarity = 'common' | 'rare' | 'epic' | 'legendary';

/** One metric that decided the archetype ("why you got this"). */
export interface StoryArchetypeMetric {
  key: string;
  label: string;
  /** Raw value in `unit`. */
  value: number;
  unit: 'pct' | 'per100' | 'words' | 'hours' | 'count' | 'ratio';
  /** Display string, e.g. '41% after 10pm'. */
  display: string;
  /** 0..1 position within the fixed band used for scoring (for a bar). */
  band: number;
}

export interface StoryArchetype {
  /** 'night_shift' | 'early_commit' | 'architect' | 'autopilot' | 'sailor' | 'diplomat' | 'loyalist' | 'sommelier'
   *  | 'marathoner' | 'tab_hoarder' | 'boss_fighter' | 'interrogator' | 'fresh_install' (thin-data fallback). */
  id: string;
  /** 'The Night Shift'. */
  title: string;
  /** Lowercase one-liner voice: "your best ideas show up after the dishwasher's done". */
  tagline: string;
  /** One or two sentences, "This year you've been ..." framing, second person. */
  profile: string;
  /** Runner-up archetype as a sub-role: {id:'sailor', label:'with a streak of The Sailor'}. Null for fresh_install. */
  subRole: {id: string; title: string; label: string} | null;
  rarity: StoryRarity;
  /** Exactly three deciding metrics, strongest first (fewer only for fresh_install). */
  deciding: readonly StoryArchetypeMetric[];
  /** Four-letter code: N/D (night/day) S/V (spec/vibe) L/R (loyal/roaming) K/H (kind/hot), e.g. 'NVRH'. */
  code: string;
  /** All archetype scores, best first (0..1). */
  scores: readonly {id: string; title: string; score: number}[];
  confidence: number;
  /** jev: title/profile wording chosen by the free Jev model from local variants (numbers validated against the fact sheet). */
  source: 'local' | 'jev';
}

/** Earned badge for the awards shelf; every award has a receipt. */
export interface StoryAward {
  id: string;
  title: string;
  /** 'Marathon: 9.5h, May 27' style evidence line (private wording may include a project name). */
  receipt: string;
  /** Number-only receipt for the public share card. */
  publicReceipt: string;
}

export interface StoryPeakTime {
  /** 0..23 local hour with most prompts. */
  hour: number;
  /** 0=Mon..6=Sun with most prompts. */
  weekday: number;
  /** 'Tuesdays around 11pm'. */
  label: string;
  /** Short narrative, Wispr-Flow style. */
  narrative: string;
  source: 'local' | 'jev';
}

export interface StoryHighlights {
  catchphrase: {phrase: string; count: number; runnersUp: readonly {phrase: string; count: number}[]} | null;
  petName: {term: string; count: number; others: readonly {term: string; count: number}[]} | null;
  /** Private text (swears masked). */
  mostTypedLine: {text: string; count: number} | null;
  mostExpensivePrompt: {costUsd: number; quote: string | null; model: string | null; day: string; project: string | null; timesMedian: number; sharePct: number} | null;
  firstPrompt: {day: string; words: number; quote: string | null; shellCommand: boolean} | null;
  latestPrompt: {day: string; words: number; quote: string | null} | null;
  fuse: {medianTurn: number; sessions: number; ofSessions: number; firstPromptSwears: number} | null;
  honeymoon: {model: string; label: string; politeEarlyPct: number; politeLatePct: number; swearEarlyPct: number; swearLatePct: number; firstDay: string} | null;
  gotAway: {project: string | null; prompts: number; activeDays: number; idleDays: number; lastDay: string; lastWords: string | null} | null;
}

export interface StoryEnrichment {
  /** offline: POTSHERD_OFFLINE=1; skipped: not enough data; pending: waiting for notice ack / response. */
  state: 'not_run' | 'offline' | 'skipped' | 'pending' | 'complete' | 'failed';
  model: string | null;
  /** Failure or skip code (timeout, invalid_response, ...). */
  code: string | null;
  /** Quotes included in the request (≤8). */
  quotesSent: number;
}

export interface AuditStory {
  version: typeof STORY_VERSION;
  /** ready: ≥200 prompts; thin: some cards suppressed for lack of data; empty: no prompts. */
  state: 'ready' | 'thin' | 'empty';
  timezone: string;
  generatedAt: string;
  totals: {
    prompts: number; sessions: number; projects: number; activeDays: number;
    firstAt: string | null; lastAt: string | null; spanDays: number;
    /** API-equivalent $ attributed to prompts (main thread + subagents). */
    costUsd: number;
    subagents: number; words: number; longestStreakDays: number;
    /** Longest unbroken stretch (gaps ≤45 min), hours. */
    longestStretchHours: number;
    tokens: number;
    byHarness: Readonly<Partial<Record<StoryHarness, number>>>;
  };
  rhythm: {
    /** Prompts per local hour 0..23. */
    hours: readonly number[];
    /** [weekday 0=Mon..6=Sun][hour 0..23]. */
    weekdayHour: readonly (readonly number[])[];
    peakHour: number | null;
    peakWeekday: number | null;
    /** Share (0..100) of active days whose last prompt lands 1:00–5:59 (days run 6am→6am). */
    lateNightDaysPct: number | null;
    weekendPct: number | null;
  };
  /** Per month: prompts, % with a swear or insult, % polite. */
  swearTimeline: readonly {month: string; prompts: number; swearing: number; swearPct: number; politePct: number}[];
  models: {
    rows: readonly StoryModelMood[];
    worst: StoryModelMood | null;
    best: StoryModelMood | null;
    basis: 'month_matched_observed';
    /** Guess-then-reveal: top 4 models by prompts answered (observed + inferred), share of prompts with a known model. */
    top: readonly {model: string; label: string; prompts: number; sharePct: number}[];
    /** Harness switch ("you left Claude Code for Codex the week of Sep 7"); null when no lasting switch. */
    defection: {from: string; to: string; week: string; weekStart: string; priorWeeks: number; shareSincePct: number} | null;
  };
  projects: readonly StoryProject[];
  highlights: StoryHighlights;
  /** Ranked cards; only detectors whose guards passed. */
  cards: readonly StoryCard[];
  /** Detectors that ran but did not fire, with the reason ('guard', 'error'). */
  suppressed: readonly {id: string; reason: string}[];
  archetype: StoryArchetype | null;
  awards: readonly StoryAward[];
  /** Card 1 cold open: one specific, timestamped, safe quote (private) or null. */
  coldOpen: {quote: string; at: string; day: string; hour: number; why: 'first_prompt' | 'most_expensive' | 'last_words' | 'late_night'} | null;
  peakTime: StoryPeakTime | null;
  enrichment: StoryEnrichment;
  timings: {featuresMs: number; detectorsMs: number};
}

/** Loading-screen detail attached to `AuditProgress.detail` (throttled to ≤20 events/s). */
export interface AuditProgressDetail {
  stage: 'discovering' | 'reading' | 'aggregating' | 'detecting' | 'ready' | 'enriching';
  harnesses: readonly {
    harness: AuditHarness;
    files: number;
    bytes: number;
    filesDone: number;
    /** Earliest / latest event seen so far in this harness (ISO). */
    firstAt: string | null;
    lastAt: string | null;
  }[];
  /** Running counts while reading (pre-dedupe for prompts; final after aggregation). */
  counts: {files: number; filesDone: number; bytes: number; bytesDone: number; messages: number; chats: number; prompts: number};
  elapsedMs: number;
}
