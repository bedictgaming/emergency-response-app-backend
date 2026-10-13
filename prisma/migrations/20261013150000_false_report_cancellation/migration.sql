-- Cancellation is a distinct terminal outcome, never a fabricated resolution.
ALTER TYPE "IncidentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "ServiceResponseStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
