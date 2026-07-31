export type PendingExportIntent = Readonly<{
  projectId: string;
  id: number;
}>;

export type PendingExportContext = Readonly<{
  accessGranted: boolean;
  projectId: string | null;
  exportDialogOpen: boolean;
  ready: boolean;
}>;

/** Keeps one export attempt alive while StoreKit is resolving, then consumes it once. */
export class PendingExportCoordinator {
  private nextId = 0;
  private pending: PendingExportIntent | null = null;

  remember(projectId: string): PendingExportIntent {
    const intent = { projectId, id: ++this.nextId };
    this.pending = intent;
    return intent;
  }

  clear(): void {
    this.pending = null;
  }

  current(): PendingExportIntent | null {
    return this.pending;
  }

  consume(context: PendingExportContext): PendingExportIntent | null {
    if (!context.accessGranted || !this.pending) return null;
    if (
      !context.exportDialogOpen ||
      context.projectId !== this.pending.projectId
    ) {
      this.clear();
      return null;
    }
    if (!context.ready) return null;

    const intent = this.pending;
    this.clear();
    return intent;
  }
}
