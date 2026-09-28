import { describe, expect, it } from "vitest";
import { createIncidentSchema } from "@/schema/incident/create-incident.schema";

const baseBody = {
  title: "Storm emergency",
  category: "other",
  barangayName: "Poblacion",
  latitude: 10.251,
  longitude: 123.949,
};

describe("multi-response incident validation", () => {
  it("requires at least two response services for Other", () => {
    const result = createIncidentSchema.safeParse({
      body: { ...baseBody, requestedServices: ["MEDICAL"] },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a unique multi-department request", () => {
    const result = createIncidentSchema.safeParse({
      body: { ...baseBody, requestedServices: ["MEDICAL", "HAZARD"] },
    });

    expect(result.success).toBe(true);
  });

  it("does not allow multi-service requests on a normal category", () => {
    const result = createIncidentSchema.safeParse({
      body: { ...baseBody, category: "fire", requestedServices: ["FIRE", "MEDICAL"] },
    });

    expect(result.success).toBe(false);
  });
});
