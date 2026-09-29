/**
 * Codex CLI version gate.
 *
 * Ported near-verbatim from obra/episodic-memory@1075769
 * `src/codex-support.ts` (MIT, (c) 2025 Jesse Vincent). Only the strict-mode
 * guards are new: potsherd compiles with `noUncheckedIndexedAccess`, so the
 * `aParts[i]` reads have to be narrowed.
 *
 * Used by the codex adapter (T1.3) and `doctor`: below this version `codex`
 * cannot be driven non-interactively, so potsherd tells the user to update
 * rather than failing obscurely later.
 */

export const MIN_CODEX_VERSION = '0.130.0';

export function parseCodexCliVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

export function compareSemver(a: string, b: string): number {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10));
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10));

  for (let i = 0; i < 3; i += 1) {
    const rawA = aParts[i];
    const rawB = bParts[i];
    const aPart = typeof rawA === 'number' && Number.isFinite(rawA) ? rawA : 0;
    const bPart = typeof rawB === 'number' && Number.isFinite(rawB) ? rawB : 0;
    if (aPart !== bPart) return aPart - bPart;
  }

  return 0;
}

export function versionMeetsMinimum(version: string, minimum = MIN_CODEX_VERSION): boolean {
  return compareSemver(version, minimum) >= 0;
}

export function codexVersionRequirementMessage(versionOutput: string): string {
  const version = parseCodexCliVersion(versionOutput);
  if (!version) {
    return `codex support needs codex-cli >= ${MIN_CODEX_VERSION}; could not read a version from: ${versionOutput.trim() || '(empty output)'}`;
  }
  return `codex support needs codex-cli >= ${MIN_CODEX_VERSION}; found ${version}. run  codex update  and retry.`;
}
