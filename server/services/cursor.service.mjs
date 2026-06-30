const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decode = (cursor, label) => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed.at || !parsed.id) throw new Error('missing fields');
    return parsed;
  } catch {
    const error = new Error(`Invalid ${label} cursor.`);
    error.statusCode = 400;
    throw error;
  }
};
export const encodeCursor = (row, atField = 'created_at') => encode({ at: row[atField], id: row.id });
export const decodeCursor = (cursor, label = 'pagination') => decode(cursor, label);
export const parseLimit = (value, fallback, maximum = 100) => Math.min(maximum, Math.max(1, Number.parseInt(value || fallback, 10) || fallback));
