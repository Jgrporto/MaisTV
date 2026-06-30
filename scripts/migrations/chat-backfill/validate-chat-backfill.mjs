import { collectPlan, validateTenant, writeReport } from './_shared.mjs';
const plan=collectPlan();
const result={legacy:plan.stats,postgres:await validateTenant(),skipped:plan.skipped};
console.log(JSON.stringify({...result,report:writeReport('chat-backfill-validation',result)},null,2));
