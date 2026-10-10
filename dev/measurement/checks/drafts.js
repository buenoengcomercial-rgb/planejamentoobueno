async page => {
await page.goto('http://127.0.0.1:5181/dev/measurement/index.html?test=drafts-'+Date.now());
await page.getByRole('button',{name:'Confirmar incorporação'}).click();
await page.getByRole('button',{name:'1.1.2Instalação de placas de sinalização'}).click();
await page.getByRole('button',{name:'Levantar coluna B da linha 1 na planta',exact:true}).click();
await page.getByRole('img',{name:'Planta e marcações'}).waitFor();
await page.getByRole('button',{name:'Contagem',exact:true}).click();
await page.getByRole('img',{name:'Planta e marcações'}).click({position:{x:230,y:220}});
await page.getByRole('img',{name:'Planta e marcações'}).click({position:{x:430,y:250}});
await page.getByRole('button',{name:'Close',exact:true}).click();
if(!await page.getByRole('dialog').isVisible())throw Error('Unfinished capture silently lost');
await page.waitForFunction(async()=>{const {measurementRepository}=await import('/src/lib/measurementWorkspaceStore.ts');const id='measurement-isolated-20261009-'+new URLSearchParams(location.search).get('test');const d=await measurementRepository({environment:'isolated',userId:'local-test',projectId:id}).drafts();return d.some(d=>d.changes.takeoffDraft?.points.length===2)});
page.once('dialog', dialog => dialog.accept());
await page.reload();await page.getByRole('button',{name:'1.1.2Instalação de placas de sinalização'}).click();
await page.getByRole('button',{name:'Levantar coluna B da linha 1 na planta',exact:true}).click();
await page.getByRole('button',{name:'Contagem',exact:true}).waitFor();
await page.getByRole('button',{name:'Concluir traçado'}).click();
await page.getByText('Planta e quantitativo salvos no navegador',{exact:true}).waitFor();
if(await page.locator('[data-measure-point]').count()!==2)throw Error('Draft points lost');
await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
if(await page.getByLabel('Medida da linha 1',{exact:true}).inputValue()!=='2')throw Error('Wrong restored destination');
await page.getByLabel('Medição selecionada').selectOption('m2');
if(await page.getByLabel('Quantidade de Instalação de placas de sinalização',{exact:true}).inputValue()!=='0')throw Error('Draft leaked into period 2');
return 'PASS unfinished capture protected, recovered two points into B after reload, second period untouched';
}