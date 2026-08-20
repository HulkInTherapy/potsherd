import fs from 'node:fs';
import path from 'node:path';
import { claudePaths } from '../paths.js';

/**
 * `projects/<slug>/sessions-index.json` exists in only a minority of project
 * dirs (4 of 16 on the reference machine) but it is the one place a deleted
 * session's *title* and message count survive. Verified shape, aug 2026:
 *
 *   {"version":1,"entries":[{sessionId, fullPath, fileMtime, firstPrompt,
 *     summary, messageCount, created, modified, gitBranch, projectPath,
 *     isSidechain}]}
 */

export interface SessionIndexEntry {
  sessionId: string;
  slug: string;
  indexPath: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

export interface SessionIndexScan {
  files: string[];
  entries: Map<string, SessionIndexEntry>;
  malformed: string[];
}

export function readSessionsIndexes(dir?: string): SessionIndexScan {
  const projectsDir = claudePaths(dir).projects;
  const out: SessionIndexScan = { files: [], entries: new Map(), malformed: [] };
  let slugs: string[];
  try {
    slugs = fs.readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const p = path.join(projectsDir, slug, 'sessions-index.json');
    if (!fs.existsSync(p)) continue;
    out.files.push(p);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      out.malformed.push(p);
      continue;
    }
    const entries = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) {
      out.malformed.push(p);
      continue;
    }
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const sessionId = typeof e['sessionId'] === 'string' ? e['sessionId'] : '';
      if (!sessionId) continue;
      // A later index file never overwrites an earlier one for the same id;
      // duplicates across slugs are the same session recorded twice.
      if (out.entries.has(sessionId)) continue;
      out.entries.set(sessionId, {
        sessionId,
        slug,
        indexPath: p,
        fullPath: str(e['fullPath']),
        fileMtime: numOr(e['fileMtime']),
        firstPrompt: str(e['firstPrompt']),
        summary: str(e['summary']),
        messageCount: numOr(e['messageCount']),
        created: str(e['created']),
        modified: str(e['modified']),
        gitBranch: str(e['gitBranch']),
        projectPath: str(e['projectPath']),
        isSidechain: e['isSidechain'] === true,
      });
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
