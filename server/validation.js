const NAME_RE = /^\S[\s\S]{0,49}$/;
const NOTE_RE = /^[\s\S]{0,120}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function requireInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${name}: invalid integer`);
  return n;
}
export function requirePositiveCents(cents, name='amount', max=1_000_000_000_00) {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > max) throw new Error(`${name}: invalid amount`);
  return cents;
}
export function requireName(value, name='name', max=40) {
  const s = String(value ?? '').trim();
  if (s.length < 1 || s.length > max || !NAME_RE.test(s)) throw new Error(`${name}: invalid value`);
  return s;
}
export function requireNote(value) {
  const s = String(value ?? '').trim();
  if (!NOTE_RE.test(s)) throw new Error('note: too long');
  return s;
}
export function requireDate(value) {
  const s = String(value ?? '');
  if (!DATE_RE.test(s)) throw new Error('date: invalid');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== s) throw new Error('date: invalid');
  const year = Number(s.slice(0,4));
  const current = new Date().getUTCFullYear();
  if (year < 2000 || year > current + 1) throw new Error('date: out of range');
  return s;
}
export function requireColor(value, fallback='#5c6bc0') {
  const s = String(value || fallback);
  if (!COLOR_RE.test(s)) throw new Error('color: invalid');
  return s.toLowerCase();
}
export function requireType(value) {
  if (value !== 'income' && value !== 'expense') throw new Error('type: invalid');
  return value;
}
export function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}
