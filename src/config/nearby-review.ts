// Paired frontend/backend rollout. Merely installing the additive schema must
// never silently reclassify existing production reports.
export const nearbyReviewEnabled = () => process.env.NEARBY_REVIEW_ENABLED === 'true';
