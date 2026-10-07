import { Loader2 } from 'lucide-react';
import { useState } from 'react';
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
  onDownload: () => boolean;
  onDiscard: () => Promise<void>;
  onContinueDailyReport?: () => void;
}

export default function CloudDraftConflictDialog({
  open,
  resolving,
  onDownload,
  onDiscard,
  onContinueDailyReport,
}: CloudDraftConflictDialogProps) {
  const [backupRequested, setBackupRequested] = useState(false);
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cópia local e nuvem estão diferentes</AlertDialogTitle>
          <AlertDialogDescription>
            A obra mudou em outro aparelho enquanto havia uma alteração local. A cópia pendente foi preservada. Baixe-a antes de descartar. O Diário pode continuar a ser preenchido separadamente, sem resolver este conflito da obra.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="outline" disabled={resolving} onClick={() => setBackupRequested(onDownload())}>
            Baixar cópia local
          </Button>
          {onContinueDailyReport && (
            <Button type="button" variant="outline" disabled={resolving} onClick={onContinueDailyReport}>
              Continuar no Diário
            </Button>
          )}
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={resolving || !backupRequested}
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
