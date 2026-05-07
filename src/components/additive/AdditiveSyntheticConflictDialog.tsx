import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blocked: boolean; // true quando aditivo aprovado/contratado/em análise
  onCancel: () => void;
  onCreateNew: () => void;
  onMergePreserving: () => void;
}

export default function AdditiveSyntheticConflictDialog({
  open, onOpenChange, blocked, onCancel, onCreateNew, onMergePreserving,
}: Props) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Atenção: o aditivo atual já possui alterações</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Este aditivo já possui alterações manuais — novos serviços, memórias de cálculo,
              insumos manuais, quantidades acrescidas/suprimidas ou outras edições.
            </span>
            <span className="block">
              {blocked
                ? 'O aditivo está enviado/aprovado/contratado e não pode ser substituído. Você pode criar um novo aditivo separado a partir da Sintética da Medição.'
                : 'Usar novamente a Sintética da Medição pode substituir informações. Como deseja continuar?'}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={onCancel}>Cancelar</Button>
          <Button variant="outline" onClick={onCreateNew}>
            Criar novo aditivo separado
          </Button>
          {!blocked && (
            <Button onClick={onMergePreserving}>
              Atualizar preservando alterações
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
