import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.restoreAllMocks(); });
async function staging() {
  vi.resetModules();
  vi.stubEnv('EVIDENCE_NAMESPACE', 'emergency-incidents-staging');
  vi.stubEnv('EVIDENCE_DELETION_ENABLED', 'false');
  return import('@/lib/cloudinary');
}
it('signs uploads only for the configured staging namespace', async () => {
  const { generateUploadSignature } = await staging();
  expect(generateUploadSignature('citizen').folder).toBe('emergency-incidents-staging/citizen');
});
it('blocks base64 uploads into the production namespace before provider access', async () => {
  const { default: cloudinary, uploadImage } = await staging();
  const upload = vi.spyOn(cloudinary.uploader, 'upload');
  await expect(uploadImage('data:image/png;base64,AAAA', 'emergency-incidents/citizen')).rejects.toThrow('outside');
  expect(upload).not.toHaveBeenCalled();
});
it('blocks provider deletion by default, including direct helper calls', async () => {
  const { default: cloudinary, deleteImage } = await staging();
  const destroy = vi.spyOn(cloudinary.uploader, 'destroy');
  await expect(deleteImage('emergency-incidents-staging/citizen/photo')).rejects.toThrow('disabled');
  expect(destroy).not.toHaveBeenCalled();
});
it('rejects traversal and malformed uploader namespaces', async () => {
  await staging();
  const { evidenceFolder, assertEvidenceScope } = await import('@/lib/evidence-scope');
  expect(() => evidenceFolder('../production')).toThrow();
  for (const id of ['emergency-incidents-staging/../photo', 'emergency-incidents-staging//photo', 'emergency-incidents-staging/citizen/../photo', 'emergency-incidents-staging/citizen\\photo/file']) {
    expect(() => assertEvidenceScope(id)).toThrow();
  }
});
