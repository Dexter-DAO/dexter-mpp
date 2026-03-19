import { describe, it, expect } from "vitest";
import { charge } from "../src/methods.js";

describe("Method schema definition", () => {
  it("has correct method name", () => {
    expect(charge.name).toBe("dexter");
  });

  it("has correct intent", () => {
    expect(charge.intent).toBe("charge");
  });

  it("has credential payload schema with transaction field", () => {
    expect(charge.schema.credential.payload).toBeDefined();
  });

  it("has request schema with required fields", () => {
    expect(charge.schema.request).toBeDefined();
  });
});
