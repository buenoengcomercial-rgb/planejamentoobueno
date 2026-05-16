/**
 * @deprecated LEGADO — substituído pelo módulo "Lista de Material" (src/components/Materials.tsx).
 * Mantido apenas para referência histórica. Não é importado em nenhum lugar do app.
 */
import { Project, Material } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { getChapterTree, getChapterNumbering } from '@/lib/chapters';
import { useState } from 'react';
import { Package, CheckCircle2, AlertCircle, Filter, FolderTree } from 'lucide-react';
import { motion } from 'framer-motion';

interface PurchasesProps {
  project: Project;
  onProjectChange: (project: Project) => void;
}

export default function Purchases({ project, onProjectChange }: PurchasesProps) {
  const [filter, setFilter] = useState<'all' | 'pendente' | 'comprado'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const tasks = getAllTasks(project);
  const allMaterials = tasks.flatMap(t => t.materials.map(m => ({ ...m, taskName: t.name, taskPhase: t.phase })));
  const categories = [...new Set(allMaterials.map(m => m.category))];

  const filtered = allMaterials.filter(m => {
    if (filter !== 'all' && m.status !== filter) return false;
    if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
    return true;
  });

  const totalCost = allMaterials.reduce((s, m) => s + (m.estimatedCost || 0), 0);
  const purchasedCost = allMaterials.filter(m => m.status === 'comprado').reduce((s, m) => s + (m.estimatedCost || 0), 0);
  const pendingCount = allMaterials.filter(m => m.status === 'pendente').length;
  const purchasedCount = allMaterials.filter(m => m.status === 'comprado').length;

  const toggleStatus = (materialId: string) => {
    const updated = {
      ...project,
      phases: project.phases.map(p => ({
        ...p,
        tasks: p.tasks.map(t => ({
          ...t,
          materials: t.materials.map(m =>
            m.id === materialId ? { ...m, status: m.status === 'comprado' ? 'pendente' as const : 'comprado' as const } : m
          ),
        })),
      })),
    };
    onProjectChange(updated);
  };

  // Group by category
  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, m) => {
    (acc[m.category] = acc[m.category] || []).push(m);
    return acc;
  }, {});

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Compras</h2>
        <p className="text-sm text-muted-foreground mt-1">Controle de materiais e insumos</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card rounded-xl p-4 border border-border shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Package className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase">Total Materiais</span>
          </div>
          <p className="text-xl font-bold text-foreground">{allMaterials.length}</p>
          <p className="text-xs text-muted-foreground mt-1">R$ {totalCost.toLocaleString('pt-BR')}</p>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-success" />
            <span className="text-xs font-medium text-muted-foreground uppercase">Comprados</span>
          </div>
          <p className="text-xl font-bold text-success">{purchasedCount}</p>
          <p className="text-xs text-muted-foreground mt-1">R$ {purchasedCost.toLocaleString('pt-BR')}</p>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-4 h-4 text-warning" />
            <span className="text-xs font-medium text-muted-foreground uppercase">Pendentes</span>
          </div>
          <p className="text-xl font-bold text-warning">{pendingCount}</p>
          <p className="text-xs text-muted-foreground mt-1">R$ {(totalCost - purchasedCost).toLocaleString('pt-BR')}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <div className="flex gap-1 bg-secondary rounded-lg p-1">
          {[{ v: 'all', l: 'Todos' }, { v: 'pendente', l: 'Pendentes' }, { v: 'comprado', l: 'Comprados' }].map(f => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v as typeof filter)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                filter === f.v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="text-xs px-3 py-2 rounded-lg border border-border bg-card text-foreground"
        >
          <option value="all">Todas categorias</option>
          {categories.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Material list grouped */}
      <div className="space-y-4">
        {Object.entries(grouped).map(([category, materials]) => (
          <motion.div
            key={category}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-card rounded-xl border border-border shadow-sm overflow-hidden"
          >
            <div className="px-5 py-3 bg-secondary/50 border-b border-border">
              <span className="text-xs font-bold text-foreground uppercase tracking-wider">{category}</span>
              <span className="text-[10px] text-muted-foreground ml-2">({materials.length} itens)</span>
            </div>
            <div className="divide-y divide-border">
              {materials.map(m => (
                <div key={m.id} className="flex items-center gap-4 px-5 py-3 hover:bg-muted/20 transition-colors">
                  <button
                    onClick={() => toggleStatus(m.id)}
                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                      m.status === 'comprado'
                        ? 'bg-success border-success'
                        : 'border-border hover:border-primary'
                    }`}
                  >
                    {m.status === 'comprado' && <CheckCircle2 className="w-3 h-3 text-success-foreground" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${m.status === 'comprado' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                      {m.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{(m as any).taskName} • {(m as any).taskPhase}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{m.quantity} {m.unit}</span>
                  <span className="text-xs font-medium text-foreground w-20 text-right">
                    R$ {(m.estimatedCost || 0).toLocaleString('pt-BR')}
                  </span>
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${
                    m.status === 'comprado' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
                  }`}>
                    {m.status === 'comprado' ? 'Comprado' : 'Pendente'}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
