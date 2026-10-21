// Paired frontend/backend rollout. Merely installing the additive schema must
// never silently reclassify existing production reports.
export const nearbyReviewEnabled = () => process.env.NEARBY_REVIEW_ENABLED === 'true';
export const nearbyResponseStartEnabled = () => nearbyReviewEnabled() && process.env.NEARBY_RESPONSE_START_ENABLED === 'true';
