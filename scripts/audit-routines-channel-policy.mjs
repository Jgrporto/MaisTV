import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonBackedStore } from '../server/sql-store.js';

const storePath = process.env.MAIN_STORE_PATH || path.resolve('server/data/store.json');
const readJson = async () => {
  try { return JSON.parse(await fs.readFile(storePath, 'utf8')); } catch { return {}; }
};
const store = await readJsonBackedStore(storePath, {}, readJson);
const routinesState = store?.routines && typeof store.routines === 'object' ? store.routines : {};
const routines = Array.isArray(routinesState.items) ? routinesState.items : Array.isArray(store?.routines) ? store.routines : [];
const rows = routines.map((routine) => {
  const serialized = JSON.stringify(routine).toLowerCase();
  return {
    id: routine.id || null,
    name: routine.name || routine.title || 'Sem nome',
    active: Boolean(routine.active || routine.isActive || routine.status === 'active'),
    usesTemplate: /hsm|template/.test(serialized),
    mayUseFreeText: /quick_reply|text|message|mensagem/.test(serialized),
    usesScheduler: /schedule|scheduler|scheduled|horario|interval/.test(serialized),
    usesLabels: /label|etiqueta/.test(serialized),
    dependsOnCustomerOrTrial: /customer|cliente|trial|teste/.test(serialized),
    explicitDefaultRoute: /routekey["']?:["']?default|route_key["']?:["']?default/.test(serialized),
    requiresManualReview: true,
  };
});
console.log(JSON.stringify({
  readOnly: true,
  routines: rows,
  totals: {
    routines: rows.length,
    activeInLegacySnapshot: rows.filter((row) => row.active).length,
    templates: rows.filter((row) => row.usesTemplate).length,
    possibleFreeText: rows.filter((row) => row.mayUseFreeText).length,
    schedulers: rows.filter((row) => row.usesScheduler).length,
  },
  warning: 'Relatorio estatico. Nenhuma rotina ou scheduler foi ativado.',
}, null, 2));

