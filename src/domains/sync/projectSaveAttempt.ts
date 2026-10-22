import type { Project } from '@/types/project';
import { CloudProjectConflictError, CloudProjectPartialSyncError, upsertCloudProject } from '@/lib/cloudProjects';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { ProjectFieldConflictError } from '@/lib/projectFieldCommit';

export interface ProjectSaveAttemptResult {
  project: Project;
  json: string;
  updatedAt: string;
  partialSyncError?: CloudProjectPartialSyncError;
}

interface ProjectSaveAttemptOptions {
  project: Project;
  organizationId: string;
  expectedUpdatedAt: () => string | null;
  onAccepted: (submitted: Project, accepted: Project, acceptedJson: string) => void;
  onFieldConflict: (error: ProjectFieldConflictError, attempted: Project) => Promise<{ project: Project; updatedAt: string }>;
  onVersionConflict: (attempted: Project) => Promise<Project | null>;
  commit?: typeof upsertCloudProject;
}

/** Saves one queued project snapshot, rebasing only when the caller confirms a safe remote change. */
export async function projectSaveAttempt({
  project, organizationId, expectedUpdatedAt, onAccepted, onFieldConflict, onVersionConflict,
  commit = upsertCloudProject,
}: ProjectSaveAttemptOptions): Promise<ProjectSaveAttemptResult> {
  let effectiveProject = project;
  let effectiveJson = serializeProject(project);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const submitted = effectiveProject;
      const updatedAt = await commit(effectiveProject, organizationId, expectedUpdatedAt() ?? undefined, accepted => {
        effectiveProject = accepted;
        effectiveJson = serializeProject(accepted);
        onAccepted(submitted, accepted, effectiveJson);
      });
      return { project: effectiveProject, json: effectiveJson, updatedAt };
    } catch (error) {
      if (error instanceof ProjectFieldConflictError) {
        const resolved = await onFieldConflict(error, effectiveProject);
        return { project: resolved.project, json: serializeProject(resolved.project), updatedAt: resolved.updatedAt };
      }
      if (attempt < 3 && error instanceof CloudProjectConflictError) {
        const rebased = await onVersionConflict(effectiveProject);
        if (rebased) {
          effectiveProject = rebased;
          effectiveJson = serializeProject(rebased);
          continue;
        }
      }
      if (error instanceof CloudProjectPartialSyncError) {
        return { project: effectiveProject, json: effectiveJson, updatedAt: error.updatedAt, partialSyncError: error };
      }
      throw error;
    }
  }
}
