import { describe, expect, it } from "vitest";
import { detectBarangayFromCoordinates, resolveBarangayFromCoordinates } from "@/lib/barangay-boundaries";

describe("barangay resolution from an incident pin", () => {
  it("prefers the polygon containing the pin over a selected nearby barangay", () => {
    const latitude = 10.2525;
    const longitude = 123.9515;
    expect(detectBarangayFromCoordinates(latitude, longitude)).toBe("Poblacion");
    expect(resolveBarangayFromCoordinates("Gabi", latitude, longitude)).toBe("Poblacion");
  });

  it("retains the selected barangay when an imprecise border is the only match", () => {
    expect(resolveBarangayFromCoordinates("Gabi", 10.262, 123.958)).toBe("Gabi");
  });

  it("rejects non-finite and clearly out-of-scope coordinates", () => {
    expect(resolveBarangayFromCoordinates("Gabi", Number.NaN, 123.958)).toBeUndefined();
    expect(resolveBarangayFromCoordinates("Gabi", 14.5995, 120.9842)).toBeUndefined();
  });

  it("accepts a legitimate Alegria pin near the simplified outline", () => {
    expect(detectBarangayFromCoordinates(10.255, 123.967)).toBe("Alegria");
  });
});
