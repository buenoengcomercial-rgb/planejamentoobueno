import { supabase } from '@/integrations/supabase/client';

export interface WarehouseAvailabilityItem {
  itemKey: string;
  requested: number;
  available: number;
}

export interface WarehouseAvailabilityResult {
  warehouseVersion: number;
  items: WarehouseAvailabilityItem[];
}

export class WarehouseAvailabilityUnavailableError extends Error {
  constructor() {
    super('A consulta antecipada de saldo ainda não está disponível neste servidor. A confirmação final continua protegida pela transação do Almoxarifado.');
    this.name = 'WarehouseAvailabilityUnavailableError';
  }
}

function validItem(value: unknown): value is WarehouseAvailabilityItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.itemKey === 'string'
    && Number.isFinite(item.requested)
    && Number.isFinite(item.available);
}

export async function checkWarehouseWithdrawalAvailability(
  projectId: string,
  items: Array<{ itemKey: string; quantity: number }>,
): Promise<WarehouseAvailabilityResult> {
  if (!navigator.onLine) throw new Error('Sem conexão com o servidor. A retirada permanece pendente.');
  if (!items.length) throw new Error('Adicione materiais antes de conferir o saldo.');
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string, args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  const { data, error } = await rpc('check_warehouse_withdrawal_availability', {
    p_project_id: projectId,
    p_items: items.map(item => ({ itemKey: item.itemKey, quantity: item.quantity })),
  });
  if (error?.code === 'PGRST202' || /could not find the function.*check_warehouse_withdrawal_availability/i.test(error?.message ?? '')) {
    throw new WarehouseAvailabilityUnavailableError();
  }
  if (error) throw new Error('Não foi possível conferir o saldo atual. A retirada permanece pendente.');
  const result = data as unknown as WarehouseAvailabilityResult;
  if (!Number.isSafeInteger(result?.warehouseVersion)
    || !Array.isArray(result.items)
    || result.items.some(item => !validItem(item))
    || result.items.length !== new Set(items.map(item => item.itemKey)).size
    || result.items.some(item => !items.some(selected => selected.itemKey === item.itemKey && selected.quantity === item.requested))) {
    throw new Error('A conferência de saldo retornou dados incompletos. A retirada permanece pendente.');
  }
  return result;
}

/** Confere a chave no livro de confirmações antes de repetir uma resposta incerta. */
export async function warehouseOperationWasCommitted(projectId: string, operationKey: string): Promise<boolean> {
  const { data, error } = await supabase.from('warehouse_operation_commits')
    .select('operation_key')
    .eq('project_id', projectId)
    .eq('operation_key', operationKey)
    .maybeSingle();
  if (error) throw new Error('Não foi possível verificar a tentativa no servidor. Mantenha este formulário aberto e tente novamente.');
  return Boolean(data);
}

export function insufficientWarehouseItems(result: WarehouseAvailabilityResult): WarehouseAvailabilityItem[] {
  return result.items.filter(item => item.requested > item.available);
}
