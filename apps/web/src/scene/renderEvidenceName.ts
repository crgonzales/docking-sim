/** Pose/settings live in the companion JSON; keep recorder names short and safe. */
export function renderEvidenceName(
  backend: 'eve' | 'lib' | 'old', quality: 'low' | 'medium', stage: string | null,
  timestamp = Date.now(),
): string {
  const captureStage = stage === 'albedo' || stage === 'lighting' ? stage : 'full';
  return `capture-${backend}-${quality}-${captureStage}-${timestamp}`;
}
