import { describe, expect, it } from 'vitest';
import { rootChapterId } from './chapters';
import type { Phase } from '@/types/project';

describe('prédio de uma tarefa', () => {
  it('segue subcapítulos aninhados até o capítulo principal', () => {
    const phases: Phase[] = [
      { id: 'predio', name: 'Prédio A', color: '#fff', tasks: [] },
      { id: 'pavimento', name: 'Térreo', color: '#fff', tasks: [], parentId: 'predio' },
      { id: 'sistema', name: 'Sinalização', color: '#fff', tasks: [], parentId: 'pavimento' },
    ];
    expect(rootChapterId(phases, 'sistema')).toBe('predio');
    expect(rootChapterId(phases, 'desconhecido')).toBeUndefined();
  });
});
