export class WorkflowConflict extends Error {}

export function isWorkflowConflict(error: unknown): boolean {
  return error instanceof WorkflowConflict ||
    (typeof error === "object" && error !== null && "code" in error && ["P2002", "P2025", "P2034"].includes(String(error.code)));
}
