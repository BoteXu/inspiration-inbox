import {mkdir,writeFile} from 'node:fs/promises';
import {ASSOCIATION_FIXTURES} from '../tests/association-fixtures.mjs';
import {rankRelated as previous} from '../tests/legacy-core.mjs';
import {createCard,expandedRelated} from '../site/core.js';
const rows=ASSOCIATION_FIXTURES.map(item=>{
  const a=createCard(item.a,'',`a-${item.id}`),b=createCard(item.b,'',`b-${item.id}`);
  const old=previous(a,[a,b]),next=expandedRelated(a,[a,b]);
  return {...item,v01Suggested:old.some(row=>row.card.id===b.id),v02Suggested:next.some(row=>row.card.id===b.id),v02Reason:next[0]?.reason||''};
});
const score=field=>{
  const positives=rows.filter(row=>row.related),negatives=rows.filter(row=>!row.related);
  return {relatedCases:positives.length,found:positives.filter(row=>row[field]).length,misses:positives.filter(row=>!row[field]).map(row=>row.id),unrelatedCases:negatives.length,falseSuggestions:negatives.filter(row=>row[field]).map(row=>row.id)};
};
const report={type:'synthetic development comparison',providerCall:false,fixtureCount:rows.length,v01:score('v01Suggested'),v02:score('v02Suggested'),rows,limitations:['Small hand-labelled development examples; not an independent test set or user study.','Language rules can join different subtopics and miss meanings outside the rule list.','This measures candidate retrieval only, not model judgement or final user acceptance.']};
await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await writeFile(new URL('../test-results/association-comparison.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({fixtures:report.fixtureCount,v01:report.v01,v02:report.v02,providerCall:false},null,2));
