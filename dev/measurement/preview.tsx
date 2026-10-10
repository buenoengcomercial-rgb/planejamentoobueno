import {useState} from 'react';
import AppSidebar from '../../src/components/AppSidebar';
import {createRoot} from 'react-dom/client';
import {TooltipProvider} from '../../src/components/ui/tooltip';
import Measurement from '../../src/components/Measurement';
import {measurementFixture} from '../../src/test/measurementWorkspaceFixture';
import {measurementRepository} from '../../src/lib/measurementWorkspaceStore';
import {createIncorporationBackup} from '../../src/lib/measurementIncorporation';
import '../../src/index.css';
const fixture=measurementFixture();
const testScope=new URLSearchParams(location.search).get('test');
if(testScope && /^[a-zA-Z0-9-]+$/.test(testScope)) fixture.project.id += '-'+testScope;
const repository=measurementRepository({environment:'isolated',userId:'local-test',projectId:fixture.project.id});
const actor={id:'local-test',name:'Teste local',canEdit:true,canReview:true};
const backup=await createIncorporationBackup(fixture.project,fixture.plans,[]);
const projects = [{id: fixture.project.id, name: fixture.project.name, createdAt: '2026-10-09', updatedAt: '2026-10-09'}];
export function Preview() {
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState('');
  return <TooltipProvider><div className="flex h-svh overflow-hidden bg-background">
    <div className="hidden shrink-0 md:block"><AppSidebar currentView="measurement" onViewChange={view => setNotice(view === 'measurement' ? '' : 'Esta prévia local permite testar a Medição. Os demais módulos continuam na plataforma.')}
      projectName={fixture.project.name} activeProjectId={fixture.project.id} projectsList={projects} collapsed={collapsed} onToggleCollapse={() => setCollapsed(!collapsed)}
      orgName="BUENO Engenharia" roleLabel="Prévia local" canManageProjects={false} canDeleteProjects={false}
      onSwitchProject={() => undefined} onCreateProject={() => undefined} onRenameProject={() => undefined} onDuplicateProject={() => undefined} onDeleteProject={() => false}/></div>
    <div className="min-w-0 flex-1 overflow-y-auto p-3 lg:p-4"><p className="mb-3 text-[11px] text-muted-foreground">Prévia local · dados isolados · nenhuma alteração na obra real</p>{notice && <p role="status" className="mb-3 text-xs text-muted-foreground">{notice}</p>}
      <Measurement project={fixture.project} onProjectChange={()=>{throw new Error("A prévia não grava no projeto operacional");}} independentWorkspace={{repository,actor,incorporationBackup:backup}}/>
    </div>
  </div></TooltipProvider>;
}
const root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<Preview/>);
