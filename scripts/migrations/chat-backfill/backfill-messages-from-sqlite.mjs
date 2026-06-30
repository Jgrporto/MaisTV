import { applyPlan, collectPlan, isConfirmed, writeReport } from './_shared.mjs';
const plan=collectPlan({only:'sqlite'});
const result=isConfirmed?await applyPlan(plan):{dryRun:true,plannedConversations:plan.conversations.length,plannedMessages:plan.messages.length};
console.log(JSON.stringify({...result,report:writeReport('chat-messages-sqlite',{...result,skipped:plan.skipped}),skipped:plan.skipped},null,2));
