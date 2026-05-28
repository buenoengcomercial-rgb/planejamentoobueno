import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Send, XCircle, CheckCircle2, RotateCcw } from 'lucide-react';
import type { AdditiveStatus } from '@/types/project';

interface Props {
  status: AdditiveStatus;
  onSend: () => void;
  onOpenReview: (preset: 'approve' | 'reject') => void;
  onBackToDraft: () => void;
  editUnlocked?: boolean;
  onUnlockIntegrated?: () => void;
}

export default function AdditiveApprovalBanner({
  status,
  onSend,
  onOpenReview,
  onBackToDraft,
  editUnlocked = false,
  onUnlockIntegrated,
}: Props) {
  return (
    <Card
      className="p-3 flex flex-wrap items-center justify-between gap-3 border-l-4"
      style={{
        borderLeftColor:
          status === 'aprovado' ? 'hsl(var(--primary))' :
          status === 'em_analise' ? '#d97706' :
          status === 'reprovado' ? '#e11d48' : '#94a3b8',
      }}
    >
      <div className="text-xs space-y-0.5">
        <div className="font-medium">Fluxo de aprovação</div>
        {status === 'rascunho' && (
          <div className="text-muted-foreground">Rascunho — uso interno apenas. Não integra Medição, Cronograma, Tarefas ou Diário.</div>
        )}
        {status === 'em_analise' && (
          <div className="text-muted-foreground">Em análise fiscal — edição bloqueada, aguardando aprovação.</div>
        )}
        {status === 'reprovado' && (
          <div className="text-muted-foreground">Reprovado — ajuste e reenvie para análise.</div>
        )}
        {status === 'aprovado' && (
          <div className="text-emerald-700">Aprovado — pronto para integração. Clique em "Integrar ao Projeto" para vincular as composições às abas Tarefas, Cronograma, Medição e Diário de Obra.</div>
        )}
        {status === 'aditivo_contratado' && !editUnlocked && (
          <div className="text-primary">Integrado ao projeto — composições vinculadas às abas Tarefas, Cronograma, Medição e Diário de Obra.</div>
        )}
        {status === 'aditivo_contratado' && editUnlocked && (
          <div className="text-amber-700">
            Revisao liberada: edite supressoes, acrescimos, novas composicoes ou exclusoes nesta aba. Depois clique em "Reintegrar ao projeto".
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {status === 'rascunho' && (
          <Button size="sm" variant="default" onClick={onSend}>
            <Send className="w-3.5 h-3.5 mr-1" /> Enviar para análise
          </Button>
        )}
        {status === 'em_analise' && (
          <>
            <Button size="sm" variant="outline" className="border-rose-300 text-rose-700"
              onClick={() => onOpenReview('reject')}>
              <XCircle className="w-3.5 h-3.5 mr-1" /> Reprovar
            </Button>
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => onOpenReview('approve')}>
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Aprovar
            </Button>
          </>
        )}
        {status === 'reprovado' && (
          <Button size="sm" variant="default" onClick={onSend}>
            <Send className="w-3.5 h-3.5 mr-1" /> Reenviar para análise
          </Button>
        )}
        {status === 'aprovado' && (
          <Button size="sm" variant="outline" onClick={onBackToDraft}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Voltar para rascunho
          </Button>
        )}
        {status === 'aditivo_contratado' && !editUnlocked && onUnlockIntegrated && (
          <Button size="sm" variant="outline" onClick={onUnlockIntegrated}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reabrir edicao
          </Button>
        )}
      </div>
    </Card>
  );
}
