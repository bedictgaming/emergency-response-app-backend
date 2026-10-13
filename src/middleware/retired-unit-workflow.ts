import type { RequestHandler } from 'express';

// Mounted after authentication/authorization; no historical personnel,
// dispatch, equipment, task or provider writes are performed here.
export const retiredUnitWorkflow: RequestHandler = (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(410).json({ code: 410, status: 'error', message: 'Unit dispatch and equipment management have been retired. Departments handle and resolve reports; staff arrange physical dispatch outside this app.' });
};
