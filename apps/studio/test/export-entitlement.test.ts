import { describe, expect, it } from "vitest";
import {
  UNLIMITED_EXPORTS_PRODUCT_ID,
  UNLOCKED_EXPORT_ENTITLEMENT,
  isPurchaseRequired,
} from "../src/export-entitlement";

describe("export entitlement helpers", () => {
  it("uses the configured non-consumable product identifier", () => {
    expect(UNLIMITED_EXPORTS_PRODUCT_ID).toBe(
      "tech.isolated.rescript.unlimited_exports"
    );
    expect(UNLOCKED_EXPORT_ENTITLEMENT).toMatchObject({
      enforcement: "none",
      entitled: true,
    });
  });

  it("recognizes structured native purchase-required errors", () => {
    expect(isPurchaseRequired({ kind: "purchaseRequired" })).toBe(true);
    expect(
      isPurchaseRequired(
        new Error('Native export failed: {"kind":"purchaseRequired"}')
      )
    ).toBe(true);
    expect(
      isPurchaseRequired({
        message: "start failed",
        cause: { kind: "purchaseRequired" },
      })
    ).toBe(true);
  });

  it("does not mistake ordinary export errors for a paywall denial", () => {
    expect(isPurchaseRequired(new Error("Export destination is unavailable"))).toBe(false);
  });
});
