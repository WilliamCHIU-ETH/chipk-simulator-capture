'use strict';

const { ContractError } = require('./errors');

function fail(code, label, detail) {
  throw new ContractError(code, `${label} ${detail}`);
}

function normalizeJsonValue(value, label = 'value', code = 'INVALID_JSON', active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code, label, 'must contain only finite JSON numbers');
    return value;
  }
  if (typeof value !== 'object') fail(code, label, 'must contain only JSON values');
  if (active.has(value)) fail(code, label, 'must not contain a cycle');

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail(code, label, 'must use a plain JSON array');
      }
      const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length) {
        fail(code, label, 'must not contain array holes, symbols, or extra fields');
      }
      return Array.from({ length: value.length }, (_, index) => {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail(code, `${label}[${index}]`, 'must be an enumerable data value');
        }
        return normalizeJsonValue(descriptor.value, `${label}[${index}]`, code, active);
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(code, label, 'must use a plain JSON object');
    }
    const entries = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(code, label, 'must not contain symbol keys');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail(code, `${label}.${key}`, 'must be an enumerable data value');
      }
      entries.push([key, normalizeJsonValue(descriptor.value, `${label}.${key}`, code, active)]);
    }
    return Object.fromEntries(entries);
  } finally {
    active.delete(value);
  }
}

function normalizeJsonObject(value, label = 'value', code = 'INVALID_JSON') {
  const normalized = normalizeJsonValue(value, label, code);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    fail(code, label, 'must be a plain JSON object');
  }
  return normalized;
}

module.exports = { normalizeJsonObject, normalizeJsonValue };
