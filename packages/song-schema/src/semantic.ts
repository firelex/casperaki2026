import type { Song } from './schemas/song.js';

export interface SemanticIssue {
  path: string;
  message: string;
}

export interface SemanticReport {
  errors: SemanticIssue[];
  warnings: SemanticIssue[];
}

export function validateSemantics(song: Song): SemanticReport {
  const errors: SemanticIssue[] = [];
  const warnings: SemanticIssue[] = [];

  const structureSegmentNames = new Set(song.songStructure.map((s) => s.name));
  for (const segName of Object.keys(song.arrangement)) {
    if (!structureSegmentNames.has(segName)) {
      warnings.push({
        path: `arrangement.${segName}`,
        message: `arrangement segment '${segName}' has no matching entry in songStructure`,
      });
    }
  }

  const instrumentNames = new Set(song.instrumentDefinitions.map((i) => i.name));
  if (instrumentNames.size > 0) {
    for (const [segName, payload] of Object.entries(song.arrangement)) {
      for (const display of Object.keys(payload.instruments)) {
        if (!instrumentNames.has(display)) {
          warnings.push({
            path: `arrangement.${segName}.instruments.${display}`,
            message: `instrument '${display}' is not declared in instrumentDefinitions`,
          });
        }
      }
    }
  }

  for (const artifact of song.aiArtifacts) {
    if (artifact.attachedTo.scope === 'segment') {
      if (!structureSegmentNames.has(artifact.attachedTo.segment)) {
        errors.push({
          path: `aiArtifacts[${artifact.id}].attachedTo.segment`,
          message: `aiArtifact references missing segment '${artifact.attachedTo.segment}'`,
        });
      }
    }
  }

  return { errors, warnings };
}
