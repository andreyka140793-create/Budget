import { badRequest } from './errors.js';
import { toCents } from './db.js';

const NOTE_MAX = 120;
const NAME_MAX = 40;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IDEM_RE = /^[A-Za-z0-9:_-]{8,100}$/;
const MAX_CENTS = 100_000_000_000; // 1 млрд ₽

export function requireInt(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name}: некорректное значение`);
  return n;
}

export function optionalInt(value, name) {
  if (value === null || value === undefined || value === '') return null;
  return requireInt(value, name);
}

export function requireAmountCents(value, name = 'Сумма') {
  const cents = toCents(value);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) {
    throw badRequest(`${name}: некорректная сумма`);
  }
  return cents;
}

export function requireName(value, name = 'Название') {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > NAME_MAX) throw badRequest(`${name}: 1–${NAME_MAX} символов`);
  return s;
}

export function requireNote(value) {
  const s = String(value ?? '').trim();
  if (s.length > NOTE_MAX) throw badRequest(`Комментарий: не более ${NOTE_MAX} символов`);
  return s;
}

export function requireIcon(value, fallback = '💰') {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  return [...s].slice(0, 2).join('');
}

export function requireType(value) {
  if (value !== 'income' && value !== 'expense') throw badRequest('Тип: income или expense');
  return value;
}

export function requireAccountType(value) {
  return ['card', 'cash', 'other'].includes(value) ? value : 'card';
}

export function requireColor(value, fallback = '#5c6bc0') {
  const s = String(value || fallback);
  if (!COLOR_RE.test(s)) throw badRequest('Цвет: формат #rrggbb');
  return s.toLowerCase();
}

export function requireDate(value, fallbackToday) {
  const s = String(value ?? '') || fallbackToday || '';
  if (!DATE_RE.test(s)) throw badRequest('Дата: формат YYYY-MM-DD');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw badRequest('Дата: такой даты не существует');
  }
  const year = Number(s.slice(0, 4));
  const current = new Date().getUTCFullYear();
  if (year < 2000 || year > current + 1) throw badRequest('Дата: вне допустимого диапазона');
  return s;
}

export function optionalIdempotencyKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  if (!IDEM_RE.test(s)) throw badRequest('idempotency_key: некорректный формат');
  return s;
}

export function requireTimezone(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 64) throw badRequest('Часовой пояс: некорректное значение');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch {
    throw badRequest('Часовой пояс: неизвестное значение');
  }
  return s;
}

export function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}
