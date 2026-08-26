export function rankAgainstTable(maxSpeedKmh, table) {
  const athletes = [...(table.athletes || [])].sort((a, b) => b.maxSpeedKmh - a.maxSpeedKmh);
  const beaten = athletes.filter((a) => maxSpeedKmh > a.maxSpeedKmh);
  const fasterThan = beaten[0] || null;
  const ahead = athletes.filter((a) => a.maxSpeedKmh >= maxSpeedKmh);
  const nextTarget = ahead.length ? ahead[ahead.length - 1] : null;
  const place = ahead.length + 1;
  return {
    athletes,
    beaten,
    fasterThan,
    nextTarget,
    place,
    total: athletes.length + 1,
    percentile: athletes.length
      ? Math.round((beaten.length / athletes.length) * 100)
      : 0,
  };
}

export function shareMessage(maxSpeedKmh, comparison, tableName) {
  const speed = formatSpeed(maxSpeedKmh);
  if (comparison.fasterThan) {
    return `אתה יותר מהיר מ-${comparison.fasterThan.name}. מהירות הריצה המקסימאלית היא: ${speed}`;
  }
  if (comparison.nextTarget) {
    return `עדיין מאחורי ${comparison.nextTarget.name} — אבל קרוב. מהירות הריצה המקסימאלית היא: ${speed}`;
  }
  return `מהירות הריצה המקסימאלית היא: ${speed} (${tableName})`;
}

export function formatSpeed(kmh) {
  const n = Number(kmh);
  if (!Number.isFinite(n)) return "0 קמ״ש";
  const rounded = Math.round(n * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} קמ״ש`;
}
