import {useState} from 'react';
import AppSidebar from '../../src/components/AppSidebar';
import {createRoot} from 'react-dom/client';
import {TooltipProvider} from '../../src/components/ui/tooltip';
import Measurement from '../../src/components/Measurement';
import {measurementFixture} from '../../src/test/measurementWorkspaceFixture';
import {measurementRepository} from '../../src/lib/measurementWorkspaceStore';
import {createIncorporationBackup} from '../../src/lib/measurementIncorporation';
import '../../src/index.css';
import {lovableSheetPreview} from './lovableSnapshot';
const params = new URLSearchParams(location.search);
const copiedSheet = params.get('source') === 'lovable';
async function loadCopiedSheet() {
  const [manifestResponse, sheetResponse] = await Promise.all([
    fetch('./local/source.json', {cache: 'no-store'}), fetch('./local/medicao.xlsx', {cache: 'no-store'}),
  ]);
  if (!manifestResponse.ok || !sheetResponse.ok) throw new Error('A exportação local do Lovable não foi encontrada. A demonstração não será usada em seu lugar.');
  const manifest = await manifestResponse.json();
  const bytes = await sheetResponse.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.sha256 || !Number.isInteger(manifest.itemCount) || manifest.itemCount < 1) throw new Error('A cópia local não corresponde à exportação conferida.');
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(bytes, {type:'array'});
  if (workbook.SheetNames.length !== 1) throw new Error('Confirme qual planilha deve ser simulada.');
  const result = await lovableSheetPreview(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header:1,defval:null}), hash);
  if (result.itemCount !== manifest.itemCount) throw new Error('A quantidade de itens difere da página original. Carga bloqueada.');
  return result;
}
let loadingError = '';
const fixture = await (copiedSheet ? loadCopiedSheet() : Promise.resolve(measurementFixture())).catch(error => {
  loadingError = error instanceof Error ? error.message : String(error);
  return null;
});
if (!fixture) {
  const alert = document.createElement('p'); alert.setAttribute('role','alert'); alert.textContent = loadingError;
  document.getElementById('root')!.replaceChildren(alert);
  throw new Error(loadingError);
}
const testScope=params.get('test');
if(testScope && /^[a-zA-Z0-9-]+$/.test(testScope)) fixture.project.id += '-'+testScope;
const repository=measurementRepository({environment:'isolated',userId:'local-test',projectId:fixture.project.id});
const actor={id:'local-test',name:'Teste local',canEdit:true,canReview:true};
const backup=await createIncorporationBackup(fixture.project,fixture.plans,[]);
// Initializes a separate dev-only copy once; reload never overwrites local edits.
if (copiedSheet && !await repository.load()) await repository.initialize(backup);
const projects = [{id: fixture.project.id, name: fixture.project.name, createdAt: '2026-10-09', updatedAt: '2026-10-09'}];
export function Preview() {
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState('');
  return <TooltipProvider><div className="flex h-svh overflow-hidden bg-background">
    <div className="hidden shrink-0 md:block"><AppSidebar currentView="measurement" onViewChange={view => setNotice(view === 'measurement' ? '' : 'Esta prévia local permite testar a Medição. Os demais módulos continuam na plataforma.')}
      projectName={fixture.project.name} activeProjectId={fixture.project.id} projectsList={projects} collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)}
      orgName={copiedSheet ? fixture.project.contractInfo?.contracted : 'BUENO Engenharia'} roleLabel="Prévia local" canManageProjects={false} canDeleteProjects={false}
      onSwitchProject={() => undefined} onCreateProject={() => undefined} onRenameProject={() => undefined} onDuplicateProject={() => undefined} onDeleteProject={() => false}/></div>
    <div className="min-w-0 flex-1 overflow-y-auto p-3 lg:p-4"><p className="mb-3 text-[11px] text-muted-foreground">{copiedSheet ? 'Cópia local da planilha do Lovable · alterações salvas somente neste navegador' : 'Prévia local · dados isolados · nenhuma alteração na obra real'}</p>{notice && <p role="status" className="mb-3 text-xs text-muted-foreground">{notice}</p>}
      <Measurement project={fixture.project} onProjectChange={()=>{throw new Error("A prévia não grava no projeto operacional");}} independentWorkspace={{repository,actor,incorporationBackup:backup}}/>
    </div>
  </div></TooltipProvider>;
}
const root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<Preview/>);
