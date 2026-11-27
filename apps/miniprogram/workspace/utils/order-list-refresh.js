const WATCH_LIMIT = 50;

function watchedIds(rows, offset = 0) {
  const ids = [...new Set(rows.map(row => row.id).filter(id => Number.isSafeInteger(id) && id > 0))];
  return ids.slice(offset, offset + WATCH_LIMIT);
}

function mergeOrderCards(current, watch, response, { atTop, present, preserve = () => false }) {
  const head = new Map(response.orders.map(row => [row.id, row]));
  const watched = new Map((response.watchedOrders || []).map(row => [row.id, row]));
  const checked = new Set(Array.isArray(response.watchedOrders) ? watch : []);
  const merged = new Map();
  for (const row of current) {
    const fresh = watched.get(row.id) || head.get(row.id);
    if (preserve(row.id)) merged.set(row.id, row);
    else if (fresh) {
      const next = present(fresh, row);
      merged.set(row.id, JSON.stringify(next) === JSON.stringify(row) ? row : next);
    } else if (!checked.has(row.id)) merged.set(row.id, row);
  }
  if (atTop) {
    const first = response.orders.map(row => merged.get(row.id) || present(row));
    return [...first, ...[...merged.values()].filter(row => !head.has(row.id))];
  }
  return [...merged.values()];
}

module.exports = { watchedIds, mergeOrderCards };
