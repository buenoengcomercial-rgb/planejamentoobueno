import { useEffect, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { listProjects as listLocalProjects, loadProject as loadLocalProject } from '@/lib/projectStorage';
import { upsertCloudProject } from '@/lib/cloudProjects';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

const MIGRATION_FLAG_PREFIX = 'obraplanner-migration-asked-';

export default function MigrationDialog({ organizationId, onMigrated }: { organizationId: string; onMigrated: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    const askedKey = `${MIGRATION_FLAG_PREFIX}${user.id}`;
    if (localStorage.getItem(askedKey)) return;
    const local = listLocalProjects();
    if (local.length > 0) {
      setCount(local.length);
      setOpen(true);
    }
  }, [user]);

  const dismiss = () => {
    if (user) localStorage.setItem(`${MIGRATION_FLAG_PREFIX}${user.id}`, '1');
    setOpen(false);
  };

  const migrate = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const local = listLocalProjects();
      let ok = 0;
      for (const meta of local) {
        const proj = loadLocalProject(meta.id);
        if (!proj) continue;
        // Garante UUID válido para a nuvem
        const cloudProject = { ...proj, id: crypto.randomUUID() };
        await upsertCloudProject(cloudProject, organizationId);
        ok++;
      }
      toast.success(`${ok} obra(s) enviada(s) para a nuvem`);
      localStorage.setItem(`${MIGRATION_FLAG_PREFIX}${user.id}`, '1');
      setOpen(false);
      onMigrated();
    } catch (e) {
      console.error(e);
      toast.error('Erro ao migrar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Enviar obras para a nuvem?</AlertDialogTitle>
          <AlertDialogDescription>
            Encontramos <strong>{count}</strong> obra(s) salva(s) neste navegador. Deseja enviá-las para sua conta na nuvem? Os dados locais serão mantidos como backup.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={dismiss} disabled={busy}>Agora não</AlertDialogCancel>
          <AlertDialogAction onClick={migrate} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Migrar para nuvem'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
