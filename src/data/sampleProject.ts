import { Project } from '@/types/project';
import { flattenTaskTree } from '@/lib/taskTree';

export const sampleProject: Project = {
  id: 'proj-001',
  name: 'Edifício Residencial Aurora',
  startDate: '2026-04-01',
  endDate: '2026-09-30',
  totalBudget: 2500000,
  phases: [
    {
      id: 'phase-1',
      name: 'Preliminares',
      color: 'hsl(var(--primary))',
      tasks: [
        {
          id: 't1', name: 'Limpeza do terreno', phase: 'Preliminares',
          startDate: '2026-04-01', duration: 5, dependencies: [], responsible: 'João Silva',
          percentComplete: 100, level: 0,
          quantity: 500, unit: 'm²',
          laborCompositions: [
            { id: 'lc1', role: 'Servente', rup: 0.08, workerCount: 2 },
            { id: 'lc2', role: 'Operador retroescavadeira', rup: 0.02, workerCount: 1 },
          ],
          materials: [
            { id: 'm1', name: 'Caçamba de entulho', quantity: 3, unit: 'un', category: 'Geral', status: 'comprado', estimatedCost: 1200 },
          ],
        },
        {
          id: 't2', name: 'Locação da obra', phase: 'Preliminares',
          startDate: '2026-04-07', duration: 3, dependencies: ['t1'], responsible: 'Carlos Eng.',
          percentComplete: 80, level: 0,
          quantity: 200, unit: 'm',
          laborCompositions: [
            { id: 'lc3', role: 'Topógrafo', rup: 0.12, workerCount: 1 },
            { id: 'lc4', role: 'Ajudante', rup: 0.08, workerCount: 2 },
          ],
          materials: [
            { id: 'm2', name: 'Estacas de madeira', quantity: 50, unit: 'un', category: 'Geral', status: 'comprado', estimatedCost: 250 },
            { id: 'm3', name: 'Linha de nylon', quantity: 200, unit: 'm', category: 'Geral', status: 'comprado', estimatedCost: 60 },
          ],
        },
        {
          id: 't3', name: 'Instalações provisórias', phase: 'Preliminares',
          startDate: '2026-04-07', duration: 7, dependencies: ['t1'], responsible: 'Pedro Mestre',
          percentComplete: 60, level: 0,
          quantity: 80, unit: 'm²',
          laborCompositions: [
            { id: 'lc5', role: 'Pedreiro', rup: 0.8, workerCount: 2 },
            { id: 'lc6', role: 'Ajudante', rup: 0.5, workerCount: 2 },
          ],
          materials: [
            { id: 'm4', name: 'Container escritório', quantity: 1, unit: 'un', category: 'Geral', status: 'comprado', estimatedCost: 3500 },
            { id: 'm5', name: 'Banheiro químico', quantity: 2, unit: 'un', category: 'Geral', status: 'pendente', estimatedCost: 800 },
          ],
        },
      ],
    },
    {
      id: 'phase-2',
      name: 'Instalação Hidráulica',
      color: 'hsl(var(--info))',
      tasks: [
        {
          id: 't4', name: 'Tubulação água fria', phase: 'Instalação Hidráulica',
          startDate: '2026-04-16', duration: 15, dependencies: ['t2'], responsible: 'Ana Hidráulica',
          percentComplete: 30, level: 0,
          quantity: 300, unit: 'm',
          laborCompositions: [
            { id: 'lc7', role: 'Encanador', rup: 0.4, workerCount: 1 },
            { id: 'lc8', role: 'Ajudante', rup: 0.25, workerCount: 1 },
          ],
          materials: [
            { id: 'm6', name: 'Tubo PVC 25mm', quantity: 300, unit: 'm', category: 'Hidráulico', status: 'comprado', estimatedCost: 2100 },
            { id: 'm7', name: 'Conexões PVC', quantity: 150, unit: 'un', category: 'Hidráulico', status: 'pendente', estimatedCost: 750 },
            { id: 'm8', name: 'Registro gaveta 25mm', quantity: 20, unit: 'un', category: 'Hidráulico', status: 'pendente', estimatedCost: 600 },
          ],
        },
        {
          id: 't5', name: 'Tubulação água quente', phase: 'Instalação Hidráulica',
          startDate: '2026-04-25', duration: 10, dependencies: ['t4'], responsible: 'Ana Hidráulica',
          percentComplete: 0, level: 0,
          quantity: 150, unit: 'm',
          laborCompositions: [
            { id: 'lc9', role: 'Encanador', rup: 0.5, workerCount: 1 },
            { id: 'lc10', role: 'Ajudante', rup: 0.3, workerCount: 1 },
          ],
          materials: [
            { id: 'm9', name: 'Tubo CPVC 22mm', quantity: 150, unit: 'm', category: 'Hidráulico', status: 'pendente', estimatedCost: 1800 },
            { id: 'm10', name: 'Conexões CPVC', quantity: 80, unit: 'un', category: 'Hidráulico', status: 'pendente', estimatedCost: 960 },
          ],
        },
        {
          id: 't6', name: 'Esgoto e drenagem', phase: 'Instalação Hidráulica',
          startDate: '2026-05-08', duration: 12, dependencies: ['t4'], responsible: 'Marcos Encanador',
          percentComplete: 0, level: 0,
          quantity: 200, unit: 'm',
          laborCompositions: [
            { id: 'lc11', role: 'Encanador', rup: 0.35, workerCount: 1 },
            { id: 'lc12', role: 'Ajudante', rup: 0.2, workerCount: 1 },
          ],
          materials: [
            { id: 'm11', name: 'Tubo PVC 100mm esgoto', quantity: 200, unit: 'm', category: 'Hidráulico', status: 'pendente', estimatedCost: 3000 },
            { id: 'm12', name: 'Caixa sifonada', quantity: 12, unit: 'un', category: 'Hidráulico', status: 'pendente', estimatedCost: 360 },
          ],
        },
      ],
    },
    {
      id: 'phase-3',
      name: 'Sistema de Incêndio',
      color: 'hsl(var(--destructive))',
      tasks: [
        {
          id: 't7', name: 'Rede de hidrantes', phase: 'Sistema de Incêndio',
          startDate: '2026-05-20', duration: 10, dependencies: ['t6'], responsible: 'Roberto Bombeiro',
          percentComplete: 0, level: 0,
          quantity: 100, unit: 'm',
          laborCompositions: [
            { id: 'lc13', role: 'Bombeiro hidráulico', rup: 0.6, workerCount: 1 },
            { id: 'lc14', role: 'Ajudante', rup: 0.35, workerCount: 1 },
          ],
          materials: [
            { id: 'm13', name: 'Tubo aço galvanizado 65mm', quantity: 100, unit: 'm', category: 'Incêndio', status: 'pendente', estimatedCost: 8500 },
            { id: 'm14', name: 'Hidrante de parede', quantity: 6, unit: 'un', category: 'Incêndio', status: 'pendente', estimatedCost: 4200 },
            { id: 'm15', name: 'Mangueira incêndio 15m', quantity: 6, unit: 'un', category: 'Incêndio', status: 'pendente', estimatedCost: 1800 },
          ],
        },
        {
          id: 't8', name: 'Sprinklers', phase: 'Sistema de Incêndio',
          startDate: '2026-06-01', duration: 8, dependencies: ['t7'], responsible: 'Roberto Bombeiro',
          percentComplete: 0, level: 0,
          quantity: 80, unit: 'un',
          laborCompositions: [
            { id: 'lc15', role: 'Bombeiro hidráulico', rup: 0.8, workerCount: 1 },
            { id: 'lc16', role: 'Ajudante', rup: 0.4, workerCount: 1 },
          ],
          materials: [
            { id: 'm16', name: 'Bico sprinkler', quantity: 80, unit: 'un', category: 'Incêndio', status: 'pendente', estimatedCost: 4800 },
            { id: 'm17', name: 'Tubo cobre 28mm', quantity: 200, unit: 'm', category: 'Incêndio', status: 'pendente', estimatedCost: 6000 },
          ],
        },
        {
          id: 't9', name: 'Alarme e detecção', phase: 'Sistema de Incêndio',
          startDate: '2026-06-05', duration: 5, dependencies: ['t7'], responsible: 'Roberto Bombeiro',
          percentComplete: 0, level: 0,
          quantity: 30, unit: 'un',
          laborCompositions: [
            { id: 'lc17', role: 'Eletricista', rup: 0.5, workerCount: 1 },
            { id: 'lc18', role: 'Ajudante', rup: 0.3, workerCount: 1 },
          ],
          materials: [
            { id: 'm18', name: 'Detector de fumaça', quantity: 30, unit: 'un', category: 'Incêndio', status: 'pendente', estimatedCost: 2100 },
            { id: 'm19', name: 'Central de alarme', quantity: 1, unit: 'un', category: 'Incêndio', status: 'pendente', estimatedCost: 3500 },
          ],
        },
      ],
    },
  ],
};

export const getAllTasks = (project: Project) => {
  return flattenTaskTree(project.phases.flatMap(p => p.tasks));
};

export const getTaskById = (project: Project, id: string) => {
  return getAllTasks(project).find(t => t.id === id);
};
