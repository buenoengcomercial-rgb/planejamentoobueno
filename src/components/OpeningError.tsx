import { Button } from '@/components/ui/button';

export function OpeningError({ message, onRetry, onExit }: { message: string; onRetry: () => void; onExit?: () => void }) {
  return <div className="min-h-dvh flex items-center justify-center bg-background p-6">
    <div className="w-full max-w-md text-center space-y-4" role="alert">
      <h1 className="text-xl font-semibold">Não foi possível abrir a plataforma</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button className="min-h-11" onClick={onRetry}>Tentar novamente</Button>
        {onExit && <Button className="min-h-11" variant="outline" onClick={onExit}>Sair</Button>}
      </div>
    </div>
  </div>;
}
