export type PatchOperation =
  | {
      type: 'create_file';
      path: string;
      diff: string;
      content: string;
    }
  | {
      type: 'replace_file';
      path: string;
      diff: string;
      newText: string;
      oldText?: string;
    }
  | {
      type: 'delete_file';
      path: string;
      diff: string;
      expectedText?: string;
    };

export interface PatchDocument {
  version: '1';
  summary: string;
  operations: PatchOperation[];
}

export type RollbackOperation =
  | {
      type: 'restore_file';
      path: string;
      content: string;
    }
  | {
      type: 'remove_file';
      path: string;
    };

export interface PatchApplyResult {
  changedFiles: string[];
  backupFiles: string[];
  rollback: RollbackOperation[];
}
