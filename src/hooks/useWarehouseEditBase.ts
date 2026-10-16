import { useRef } from 'react';
import type { Project } from '@/types/project';

export function useWarehouseEditBase(project: Project, editing: string | boolean | null) {
  const saved = useRef<{ editing: typeof editing; project: Project }>();
  if (!editing || saved.current?.editing !== editing || saved.current?.project.id !== project.id) {
    saved.current = { editing, project };
  }
  return { project: saved.current!.project,
    confirmed: (value: Project) => { saved.current = { editing, project: value }; } };
}
