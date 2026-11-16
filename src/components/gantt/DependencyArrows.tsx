import { Task, DependencyType } from '@/types/project';
import { DEP_COLORS } from './types';
import { diffDays, parseISODateLocal } from './utils';

interface TaskYPosition {
  taskId: string;
  yCenter: number;
}

interface Props {
  tasks: Task[];
  taskYPositions: Map<string, number>; // taskId -> yCenter in px
  projectStart: Date;
  dayWidth: number;
  violations: Map<string, Set<string>>; // taskId -> set of violated dep taskIds
}

export default function DependencyArrows({ tasks, taskYPositions, projectStart, dayWidth, violations }: Props) {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  const arrows: JSX.Element[] = [];

  // Collect all dependency types for marker defs
  const usedTypes = new Set<DependencyType>();

  tasks.forEach(task => {
    const details = task.dependencyDetails || task.dependencies.map(id => ({ taskId: id, type: 'TI' as const }));
    details.forEach(dep => {
      const src = taskMap.get(dep.taskId);
      if (!src) return;

      const srcY = taskYPositions.get(src.id);
      const tgtY = taskYPositions.get(task.id);
      if (srcY === undefined || tgtY === undefined) return;

      const predStart = diffDays(projectStart, parseISODateLocal(src.startDate));
      const predLast = src.operationalReschedule?.monthlySegments?.at(-1)?.endDate;
      const predEnd = predLast ? diffDays(projectStart, parseISODateLocal(predLast)) + 1 : predStart + src.duration;
      const succStart = diffDays(projectStart, parseISODateLocal(task.startDate));
      const succLast = task.operationalReschedule?.monthlySegments?.at(-1)?.endDate;
      const succEnd = succLast ? diffDays(projectStart, parseISODateLocal(succLast)) + 1 : succStart + task.duration;

      const xPredLeft = predStart * dayWidth;
      const xPredRight = predEnd * dayWidth;
      const xSuccLeft = succStart * dayWidth;
      const xSuccRight = succEnd * dayWidth;

      let x1: number, x2: number;
      switch (dep.type) {
        case 'TI': x1 = xPredRight; x2 = xSuccLeft;  break;
        case 'II': x1 = xPredLeft;  x2 = xSuccLeft;  break;
        case 'TT': x1 = xPredRight; x2 = xSuccRight; break;
        case 'IT': x1 = xPredLeft;  x2 = xSuccRight; break;
        default:   x1 = xPredRight; x2 = xSuccLeft;
      }

      const isViolated = violations.get(task.id)?.has(dep.taskId) ?? false;
      const color = isViolated ? '#DC2626' : (DEP_COLORS[dep.type] || '#378ADD');
      const midX = (x1 + x2) / 2;
      const markerId = isViolated ? 'arrow-violation' : `arrow-${dep.type}`;

      usedTypes.add(dep.type);

      arrows.push(
        <g key={`${src.id}-${task.id}-${dep.type}`}>
          <path
            d={`M ${x1} ${srcY} C ${midX} ${srcY}, ${midX} ${tgtY}, ${x2} ${tgtY}`}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray={isViolated ? '6,3' : (dep.type === 'IT' ? '4,2' : undefined)}
            opacity={isViolated ? 0.9 : 0.7}
            markerEnd={`url(#${markerId})`}
          />
        </g>
      );
    });
  });

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none"
      style={{ width: '100%', height: '100%', zIndex: 15, overflow: 'visible' }}
    >
      <defs>
        {Array.from(usedTypes).map(type => (
          <marker
            key={type}
            id={`arrow-${type}`}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DEP_COLORS[type]} opacity={0.8} />
          </marker>
        ))}
        <marker
          id="arrow-violation"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#DC2626" opacity={0.9} />
        </marker>
      </defs>
      {arrows}
    </svg>
  );
}
