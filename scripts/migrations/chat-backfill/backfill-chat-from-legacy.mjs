import { applyPlan, collectPlan, isConfirmed, writeReport } from './_shared.mjs';
const plan=collectPlan();
const result=isConfirmed?await applyPlan(plan):{dryRun:true,plannedConversations:plan.conversations.length,plannedMessages:plan.messages.length};
const report=writeReport('chat-backfill',{...result,tenantId:plan.tenantId,mode:plan.mode,stats:plan.stats,skipped:plan.skipped});
console.log(JSON.stringify({...result,stats:plan.stats,report,skipped:plan.skipped},null,2));
