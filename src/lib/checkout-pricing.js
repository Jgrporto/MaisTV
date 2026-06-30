export const CHECKOUT_PRICE_TABLE = Object.freeze({
  1: Object.freeze({ 1: 22, 2: 32, 3: 42 }),
  2: Object.freeze({ 1: 32, 2: 52, 3: 72 }),
  3: Object.freeze({ 1: 42, 2: 72, 3: 102 }),
  4: Object.freeze({ 1: 52, 2: 92, 3: 132 }),
});

export const CHECKOUT_ALLOWED_CONNECTIONS = Object.freeze([1, 2, 3, 4]);
export const CHECKOUT_ALLOWED_MONTHS = Object.freeze([1, 2, 3]);

export const isAllowedCheckoutConnections = (value) =>
  CHECKOUT_ALLOWED_CONNECTIONS.includes(Number(value));

export const isAllowedCheckoutMonths = (value) =>
  CHECKOUT_ALLOWED_MONTHS.includes(Number(value));

export const resolveCheckoutPrice = ({ connections, planMonths }) => {
  const safeConnections = Number(connections);
  const safeMonths = Number(planMonths);
  return CHECKOUT_PRICE_TABLE[safeConnections]?.[safeMonths] || null;
};

