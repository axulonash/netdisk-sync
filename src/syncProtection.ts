export interface ProtectionRequest {
  modifiedCount: number;
  deletedCount: number;
  deletedPaths: string[];
  allFilesCount: number;
}
export interface SyncRunHooks {
  preparePlan?: (plan:Record<string,import("./baseTypes").MixedEntity>)=>void;
  validatePlan?: (plan:Record<string,import("./baseTypes").MixedEntity>)=>void;
  guard?: () => void;
  checkpoint?: () => Promise<void>;
  authorizeLargeChanges?: (request: ProtectionRequest) => Promise<boolean>;
  onPlan?: (summary: import("./syncProgress").SyncPlanSummary) => void;
  onTask?: (event: import("./syncProgress").SyncTaskEvent) => void;
  onPhase?: (phase: "remote" | "local" | "planning") => void;
}
export class SyncProtectionError extends Error {
  constructor(
    public readonly code: "sync_protected" | "plan_changed",
    public readonly request?: ProtectionRequest,
    message = "Large sync changes paused"
  ) {
    super(message);
    this.name = "SyncProtectionError";
  }
}
export class SyncScopeError extends Error {
  readonly code = "sync_scope_changed";
  constructor() {
    super("Sync settings changed");
    this.name = "SyncScopeError";
  }
}
