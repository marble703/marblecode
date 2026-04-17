import type { PatchDocument, PatchOperation } from './types.js';

export function parsePatchDocument(raw: string): PatchDocument {
  const parsed = JSON.parse(raw) as Partial<PatchDocument>;
  if (parsed.version !== '1') {
    throw new Error('Patch version must be "1"');
  }

  if (!parsed.summary || !Array.isArray(parsed.operations) || parsed.operations.length === 0) {
    throw new Error('Patch must include a summary and at least one operation');
  }

  for (const operation of parsed.operations) {
    validateOperation(operation as PatchOperation);
  }

  return parsed as PatchDocument;
}

function validateOperation(operation: PatchOperation): void {
  if (!operation.path || !operation.diff) {
    throw new Error('Patch operation must include path and diff');
  }

  if (operation.type === 'create_file' && typeof operation.content !== 'string') {
    throw new Error('create_file requires content');
  }

  if (operation.type === 'replace_file' && typeof operation.newText !== 'string') {
    throw new Error('replace_file requires newText');
  }
}
