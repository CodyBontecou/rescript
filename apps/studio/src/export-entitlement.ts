import { addPluginListener, invoke, isTauri } from "@tauri-apps/api/core";

export const UNLIMITED_EXPORTS_PRODUCT_ID =
  "tech.isolated.rescript.unlimited_exports" as const;

export type ExportEntitlementState = {
  enforcement: "storeKit" | "none";
  entitled: boolean;
  productId: string;
  displayPrice: string | null;
  canPurchase: boolean;
};

export type ExportPurchaseOutcome =
  | "purchased"
  | "alreadyEntitled"
  | "restored"
  | "notFound"
  | "pending"
  | "cancelled"
  | "notApplicable";

export type ExportPurchaseResult = {
  outcome: ExportPurchaseOutcome;
  entitlement: ExportEntitlementState;
};

export const UNLOCKED_EXPORT_ENTITLEMENT: ExportEntitlementState = {
  enforcement: "none",
  entitled: true,
  productId: UNLIMITED_EXPORTS_PRODUCT_ID,
  displayPrice: null,
  canPurchase: false,
};

export const LOCKED_EXPORT_ENTITLEMENT: ExportEntitlementState = {
  enforcement: "storeKit",
  entitled: false,
  productId: UNLIMITED_EXPORTS_PRODUCT_ID,
  displayPrice: null,
  canPurchase: false,
};

const PURCHASE_OUTCOMES = new Set<ExportPurchaseOutcome>([
  "purchased",
  "alreadyEntitled",
  "restored",
  "notFound",
  "pending",
  "cancelled",
  "notApplicable",
]);

function entitlementFrom(value: unknown): ExportEntitlementState {
  if (!value || typeof value !== "object") {
    throw new Error("The App Store returned an invalid entitlement response.");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.enforcement !== "storeKit" && record.enforcement !== "none") ||
    typeof record.entitled !== "boolean" ||
    typeof record.productId !== "string" ||
    (record.displayPrice !== null && typeof record.displayPrice !== "string") ||
    typeof record.canPurchase !== "boolean"
  ) {
    throw new Error("The App Store returned an invalid entitlement response.");
  }
  return {
    enforcement: record.enforcement,
    entitled: record.entitled,
    productId: record.productId,
    displayPrice: record.displayPrice as string | null,
    canPurchase: record.canPurchase,
  };
}

function purchaseResultFrom(value: unknown): ExportPurchaseResult {
  if (!value || typeof value !== "object") {
    throw new Error("The App Store returned an invalid purchase response.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.outcome !== "string" ||
    !PURCHASE_OUTCOMES.has(record.outcome as ExportPurchaseOutcome)
  ) {
    throw new Error("The App Store returned an invalid purchase response.");
  }
  return {
    outcome: record.outcome as ExportPurchaseOutcome,
    entitlement: entitlementFrom(record.entitlement),
  };
}

export async function getExportEntitlement(): Promise<ExportEntitlementState> {
  if (!isTauri()) return UNLOCKED_EXPORT_ENTITLEMENT;
  return entitlementFrom(await invoke("export_entitlement_status"));
}

export async function purchaseUnlimitedExports(): Promise<ExportPurchaseResult> {
  if (!isTauri()) {
    return {
      outcome: "notApplicable",
      entitlement: UNLOCKED_EXPORT_ENTITLEMENT,
    };
  }
  return purchaseResultFrom(await invoke("purchase_unlimited_exports"));
}

export async function restoreExportPurchases(): Promise<ExportPurchaseResult> {
  if (!isTauri()) {
    return {
      outcome: "notApplicable",
      entitlement: UNLOCKED_EXPORT_ENTITLEMENT,
    };
  }
  return purchaseResultFrom(await invoke("restore_export_purchases"));
}

export async function listenForExportEntitlementChanges(
  onChange: (state: ExportEntitlementState) => void
): Promise<() => Promise<void>> {
  if (!isTauri()) return async () => undefined;
  const platform = await invoke<{ os: string }>("platform_info");
  if (platform.os !== "ios") return async () => undefined;
  const listener = await addPluginListener<unknown>(
    "av-media",
    "exportEntitlementChanged",
    (payload) => onChange(entitlementFrom(payload))
  );
  return async () => listener.unregister();
}

export function isPurchaseRequired(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined || seen.has(value)) return false;
    if (typeof value === "string") {
      return value.toLowerCase().includes("purchaserequired") ||
        value.toLowerCase().includes("purchase required");
    }
    if (typeof value !== "object") return false;
    seen.add(value);
    if (value instanceof Error && visit(value.message)) return true;
    const record = value as Record<string, unknown>;
    if (record.kind === "purchaseRequired") return true;
    return Object.values(record).some(visit);
  };
  return visit(cause);
}
