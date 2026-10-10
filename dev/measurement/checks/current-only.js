async page => {
 await page.goto('http://127.0.0.1:5181/dev/measurement/index.html?test=current-only-'+Date.now());
 await page.setViewportSize({width:1920,height:1000});
 await page.getByRole('button',{name:'Confirmar incorporação'}).click();
 const row=page.getByTestId('service-signs'), cells=row.locator('td');
 const q=page.getByLabel('Quantidade de Instalação de placas de sinalização',{exact:true});
 const period=page.getByLabel('Medição selecionada');
 const ready=()=>page.locator('[role=status]').filter({hasText:'Salvo neste navegador'}).waitFor();
 const assert=(ok,msg)=>{if(!ok)throw new Error(msg)};
 await q.fill('7');await q.press('Enter');await ready();
 await period.selectOption('m2');
 assert(await q.inputValue()==='0','2nd period inherited first quantity');
 assert((await cells.nth(11).innerText()).trim()==='7','first accumulated !=7');
 for(const i of [5,6,7,8,10,11,12,13,14]){
  assert(await cells.nth(i).locator('button,input').count()===0,'Calculated/contract field is editable: '+i);
  await cells.nth(i).click();
  assert(await page.getByLabel('Unidades da linha 1',{exact:true}).count()===0,'Wrong cell opened detail: '+i);
 }
 const action=cells.nth(9).getByRole('button',{name:'Detalhar quantidade da 2ª medição: Instalação de placas de sinalização'});
 await action.click();
 await page.getByText('Detalhe de quantitativos · 2ª medição',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Levantar coluna A da linha 1 na planta',exact:true}).click();
 await page.getByRole('img',{name:'Planta e marcações'}).waitFor();
 await page.getByRole('button',{name:'Contagem',exact:true}).click();
 const drawing=page.getByRole('img',{name:'Planta e marcações'});
 for(const point of [{x:300,y:230},{x:500,y:300},{x:700,y:380}])await drawing.click({position:point});
 await page.getByRole('button',{name:'Concluir traçado'}).click();
 await page.getByText('Planta e quantitativo salvos no navegador',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 assert(await q.inputValue()==='3','current quantity !=3');
 assert((await cells.nth(5).innerText()).trim()==='400','contract changed');
 assert((await cells.nth(11).innerText()).trim()==='10','accumulated !=10');
 assert((await cells.nth(10).innerText()).includes('37,50'),'current money wrong');
 await period.selectOption('m1');assert(await q.inputValue()==='7','first period overwritten');
 await page.reload();await period.selectOption('m2');
 assert(await q.inputValue()==='3','second period lost after reload');
 await action.click();
 await page.getByRole('button',{name:'Levantar coluna A da linha 1 na planta',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-measure-point]').length===3);
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.locator('.measurement-table-scroll').evaluate(el=>el.scrollLeft=0);
 await page.locator('.fixed.inset-0[data-state=closed]').waitFor({state:'detached'});
 await page.screenshot({path:'output/playwright/measurement-current-only.png',fullPage:true});
 return 'PASS: contract 400 unchanged, 1st=7, 2nd=3, accumulated=10, second value=37.50, marks recovered. Detail only in current quantity.';
}
