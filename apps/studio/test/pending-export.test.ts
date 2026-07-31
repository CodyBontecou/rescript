import { describe, expect, it } from "vitest";
import { PendingExportCoordinator } from "../src/pending-export";

describe("PendingExportCoordinator", () => {
  it("holds a locked export and consumes it exactly once after access is granted", () => {
    const pending = new PendingExportCoordinator();
    const remembered = pending.remember("project-a");

    expect(
      pending.consume({
        accessGranted: false,
        projectId: "project-a",
        exportDialogOpen: true,
        ready: true,
      })
    ).toBeNull();
    expect(pending.current()).toEqual(remembered);

    expect(
      pending.consume({
        accessGranted: true,
        projectId: "project-a",
        exportDialogOpen: true,
        ready: true,
      })
    ).toEqual(remembered);
    expect(
      pending.consume({
        accessGranted: true,
        projectId: "project-a",
        exportDialogOpen: true,
        ready: true,
      })
    ).toBeNull();
  });

  it("does not consume while the editor is busy", () => {
    const pending = new PendingExportCoordinator();
    pending.remember("project-a");

    expect(
      pending.consume({
        accessGranted: true,
        projectId: "project-a",
        exportDialogOpen: true,
        ready: false,
      })
    ).toBeNull();
    expect(pending.current()?.projectId).toBe("project-a");
  });

  it("invalidates an attempt when its dialog or project is gone", () => {
    const pending = new PendingExportCoordinator();
    pending.remember("project-a");
    expect(
      pending.consume({
        accessGranted: true,
        projectId: "project-b",
        exportDialogOpen: true,
        ready: true,
      })
    ).toBeNull();
    expect(pending.current()).toBeNull();

    pending.remember("project-b");
    expect(
      pending.consume({
        accessGranted: true,
        projectId: "project-b",
        exportDialogOpen: false,
        ready: true,
      })
    ).toBeNull();
    expect(pending.current()).toBeNull();
  });

  it("lets a dismissed paywall clear the pending export", () => {
    const pending = new PendingExportCoordinator();
    pending.remember("project-a");
    pending.clear();
    expect(pending.current()).toBeNull();
  });
});
