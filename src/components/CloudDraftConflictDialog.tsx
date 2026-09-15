import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface CloudDraftConflictDialogProps {
  open: boolean;
  resolving: boolean;
  onDownload: () => void;
  onDiscard: () => Promise<void>;
}

export default function CloudDraftConflictDialog({
  open,
  resolving,
  onDownload,
  onDiscard,
}: CloudDraftConflictDialogProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cópia local e nuvem estão diferentes</AlertDialogTitle>
          <AlertDialogDescription>
            A obra mudou em outro aparelho enquanto havia uma alteração local. Para evitar sobrescrever dados, a plataforma está bloqueada. Você pode baixar a cópia local antes de optar pela versão confirmada na nuvem.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" disabled={resolving} onClick={onDownload}>
            Baixar cópia local
          </Button>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={resolving}
            onClick={event => {
              event.preventDefault();
              void onDiscard();
            }}
          >
            {resolving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Descartar cópia e usar nuvem
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
