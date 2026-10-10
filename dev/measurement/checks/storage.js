async page => {
return await page.evaluate(async () => {
 const {measurementFixture}=await import('/src/test/measurementWorkspaceFixture.ts');
 const {measurementRepository}=await import('/src/lib/measurementWorkspaceStore.ts');
 const {createIncorporationBackup}=await import('/src/lib/measurementIncorporation.ts');
 const {editMeasuredRow,newMeasuredRow,captureMeasurement,monthlyLines}=await import('/src/lib/measurementWorkspace.ts');
 const assert=(ok,m)=>{if(!ok)throw new Error(m)};
 const f=measurementFixture();f.project.id='store-tests-'+crypto.randomUUID();
 const actor={id:'storage-test',name:'Storage test',canEdit:true};
 const scope={environment:'isolated',userId:actor.id,projectId:f.project.id};
 const a=measurementRepository(scope), b=measurementRepository(scope);
 const backup=await createIncorporationBackup(f.project,f.plans,[]);
 let w=await a.initialize(backup);assert((await a.initialize(backup)).revision===0,'idempotency');
 let c=editMeasuredRow(w,actor,'m1','signs',{...newMeasuredRow('row'),multiplier:3});
 await a.commit(c,0);assert((await b.load()).entries.find(e=>e.serviceId==='signs').rows[0].multiplier===3,'reload');
 const stale=editMeasuredRow(w,actor,'m2','signs',{...newMeasuredRow('other'),multiplier:4});
 try{await b.commit(stale,0);throw Error('Expected conflict')}catch(e){assert(e.message.includes('Conflito'),'CAS conflict')}
 assert((await a.load()).revision===1,'conflict partially applied');assert((await b.pending()).candidate.revision===1,'conflict draft missing');
 await a.writeDraft({projectId:w.projectId,measurementId:'m1',serviceId:'signs',rowId:'typed',changes:{multiplier:'33'}});
 await a.writeDraft({projectId:w.projectId,measurementId:'m2',serviceId:'signs',rowId:'typed',changes:{multiplier:'55'}});
 assert((await b.drafts()).length===2,'draft leaked across periods');
 w=await a.load();const mark={id:'atomic',name:'3 points',kind:'count',page:1,points:[{x:1,y:1},{x:2,y:2},{x:3,y:3}],projectId:w.projectId,measurementId:'m1',serviceId:'signs'};
 c=captureMeasurement(w,actor,{measurementId:'m1',serviceId:'signs',rowId:'row',field:'multiplier'},{...w.plans[0],measures:[mark]},mark);
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){if(this.name==='workspaces')throw new DOMException('Simulated disk failure','QuotaExceededError');return put.apply(this,args)};
 try {await a.commit(c,w.revision);throw Error('Expected storage failure')}catch(e){assert(e.name==='QuotaExceededError','Unexpected failure '+e)}finally{IDBObjectStore.prototype.put=put}
 const unchanged=await a.load();assert(unchanged.plans[0].measures.length===0,'partial geometry persisted');assert(unchanged.revision===w.revision,'partial quantity persisted');
 await a.commit(c,w.revision);const saved=await a.load();assert(saved.plans[0].measures.length===1,'retry geometry');assert(saved.audit.at(-1).afterPlans[0].measures.length===1,'missing capture audit');
 const another=measurementRepository({...scope,userId:'another-user'});assert(await another.load()===null,'user isolation');
 const anotherProject=measurementRepository({...scope,projectId:'other-project'});assert(await anotherProject.load()===null,'project isolation');
 return {passed:['idempotent incorporation','reload','compare-and-swap conflict','conflict draft','period-scoped drafts','failed atomic capture rollback','retry both quantities and geometry','user isolation','project isolation'],revision:saved.revision};
});
}