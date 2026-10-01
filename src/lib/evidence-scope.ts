import { ENV } from '@/config/env';

/** Every application upload/delete is limited to this environment's namespace. */
export function assertEvidenceScope(publicId: string): void {
  const segments = publicId.split('/');
  if (segments.length < 3 || segments[0] !== ENV.EVIDENCE_NAMESPACE
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || /[\\\x00-\x1f\x7f]/.test(publicId)) {
    throw new Error('Evidence is outside the configured storage namespace');
  }
}

export function evidenceFolder(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid evidence uploader');
  return `${ENV.EVIDENCE_NAMESPACE}/${userId}`;
}
