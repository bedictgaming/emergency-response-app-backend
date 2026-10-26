// Read at the application boundary; domain policies receive an explicit mode.
// Strict boolean validation remains in config/env.ts at server startup.
export const departmentReportReviewEnabled = () => process.env.DEPARTMENT_REPORT_REVIEW_ENABLED === 'true';
