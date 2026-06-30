export const CHECKOUT_PLAN_BY_MONTH = Object.freeze({
  1: Object.freeze({ packageId: 'BV4D3rLaqZ', planLabel: '[1 MES] COMPLETO' }),
  2: Object.freeze({ packageId: 'EMeWepDnN9', planLabel: '[2 MESES] COMPLETO' }),
  3: Object.freeze({ packageId: 'bOxLAQLZ7a', planLabel: '[3 MESES] COMPLETO' }),
});

export const resolveCheckoutPlan = (months) => CHECKOUT_PLAN_BY_MONTH[Number(months)] || null;
