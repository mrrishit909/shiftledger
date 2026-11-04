import assert from 'node:assert/strict';
import * as a from '../../src/index.js';
const failures=[];let passed=0;
function check(name,fn){try{fn();passed++;}catch(e){failures.push({name,error:e.message});}}
function rejected(fn){try {let r=fn();assert.equal(r?.ok,false);}catch(e){if(e instanceof assert.AssertionError)throw e;}}
const raw=a.goldenFixture(); const r=a.reconcile(raw).report;
check('literal oracle',()=>{assert.equal(r.totals.rawReported,1560);assert.equal(r.totals.dedupReported,1080);assert.equal(r.totals.eligibleSupport,1020);assert.equal(r.totals.dedupMinusSupport,60);assert.equal(r.partition.matched,780);assert.equal(r.partition.classificationConflict,240);assert.equal(r.partition.unsupported,60);assert.equal(r.findings.length,3);});
check('corrected oracle',()=>{const c=a.reconcile(a.correctedFixture()).report;assert.equal(c.totals.rawReported,1020);assert.equal(c.findings.length,0);assert.equal(c.totals.scheduleMinusSupport,60)});
const input={findingId:r.findings[0].id,decision:'ACKNOWLEDGED',reviewerId:'QA',note:'=1+1 <img src=x>',decidedAt:'2026-11-03T12:00:00Z'};
check('impossible date rejected',()=>rejected(()=>a.createDecision(r,{...input,decidedAt:'2026-02-30T12:00:00Z'})));
check('impossible time rejected',()=>rejected(()=>a.createDecision(r,{...input,decidedAt:'2026-11-03T25:00:00Z'})));
check('null report rejected',()=>rejected(()=>a.createDecision(null,input)));
check('valid annotation export',()=>{const d=a.createDecision(r,input);assert.equal(d.ok,true);const log=a.appendDecision([],r,d.decision);assert.equal(log.ok,true);const e=JSON.parse(a.exportReportJson(r,log.log));assert.equal(e.certified,false);assert.equal(e.report.totals.dedupReported,1080)});
for(const kind of ['totals','findings','provenance']){
 const t=structuredClone(r);if(kind==='totals')t.totals.dedupReported=1;if(kind==='findings')t.findings=[];if(kind==='provenance')t.provenance.datasetId='OTHER';
 check('tampered '+kind+' JSON rejected',()=>rejected(()=>a.exportReportJson(t)));
 check('tampered '+kind+' CSV rejected',()=>rejected(()=>a.exportReportCsv(t)));
}
check('rehash fabricated report rejected',()=>{const t=structuredClone(r);t.findings=[];const {reportId,...body}=t;t.reportId='SLR-'+a.sha256Hex(a.canonicalJson(body));rejected(()=>a.exportReportJson(t));});
check('forged annotations cannot close review',()=>{const forged=r.findings.map(f=>({reportId:r.reportId,findingId:f.id}));try{assert.notEqual(a.readiness(r,forged).status,'REVIEWED_NOT_CERTIFIED')}catch(e){if(e instanceof assert.AssertionError)throw e;}});
check('normalized IO accepted',()=>{const ds=a.validateDataset(raw).dataset;assert.equal(a.reconcile(a.importDatasetJson(a.exportDatasetJson(ds)).dataset).report.reportId,r.reportId);assert.equal(a.reconcile(a.importDatasetCsv(a.exportDatasetCsv(ds)).dataset).report.reportId,r.reportId)});
check('unknown CSV envelope rejected',()=>{const b=a.exportDatasetCsv(a.validateDataset(raw).dataset);b.extra=true;assert.equal(a.importDatasetCsv(b).ok,false)});
console.log(JSON.stringify({passed,failed:failures.length,failures},null,2));process.exitCode=failures.length?1:0;
