import { applyPlan, collectPlan, isConfirmed, writeReport } from './_shared.mjs';
const plan=collectPlan({only:'json'}); plan.messages=[];
const result=isConfirmed?await applyPlan(plan):{dryRun:true,plannedConversations:plan.conversations.length};
console.log(JSON.stringify({...result,report:writeReport('chat-conversations-json',{...result,skipped:plan.skipped}),skipped:plan.skipped},null,2));
