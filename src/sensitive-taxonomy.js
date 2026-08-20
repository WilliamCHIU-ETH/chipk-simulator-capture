'use strict';

const { isIP } = require('node:net');

const INTERNAL_HOST_LABELS = new Set([
  'admin',
  'builder',
  'corp',
  'corporate',
  'dev',
  'development',
  'internal',
  'intranet',
  'qa',
  'sandbox',
  'stage',
  'staging',
  'test',
  'uat',
]);
const LOCALHOST = ['local', 'host'].join('');
const COMPANY_HOST_FRAGMENT = ['c', 'money'].join('');
const SENSITIVE_FIELD_TOKENS = new Set([
  ['per', 'sona'].join(''),
  ['creden', 'tial'].join(''),
  ['pass', 'word'].join(''),
  ['sec', 'ret'].join(''),
  ['to', 'ken'].join(''),
  ['coo', 'kie'].join(''),
  ['ses', 'sion'].join(''),
  ['m', 'fa'].join(''),
  ['reco', 'very'].join(''),
  ['log', 'in'].join(''),
  ['authoriz', 'ation'].join(''),
  ['user', 'name'].join(''),
  ['e', 'mail'].join(''),
  ['acc', 'ount'].join(''),
]);
const SENSITIVE_FIELD_SEQUENCES = Object.freeze([
  [['user'].join(''), ['id'].join('')],
  [['member'].join(''), ['id'].join('')],
  [['api'].join(''), ['key'].join('')],
  [['access'].join(''), ['key'].join('')],
  [['auth'].join(''), ['header'].join('')],
  [['acc', 'ount'].join(''), ['name'].join('')],
  [['acc', 'ount'].join(''), ['id'].join('')],
  [['profile'].join(''), ['id'].join('')],
  [['private'].join(''), ['key'].join('')],
  [['client'].join(''), ['key'].join('')],
  [['oauth'].join(''), ['client'].join(''), ['id'].join('')],
  [['sign', 'ing'].join(''), ['key'].join('')],
  [['s', 'sh'].join(''), ['key'].join('')],
  [['key'].join(''), ['mater', 'ial'].join('')],
]);
const SENSITIVE_COMPACT_FIELDS = new Set([
  ...SENSITIVE_FIELD_TOKENS,
  ...SENSITIVE_FIELD_SEQUENCES.map((sequence) => sequence.join('')),
]);
const SYSTEM_PATH_PATTERN = new RegExp(
  String.raw`(?:^|[\s="'(:])(?:~\/|\/(?:[U]sers|Applications|[L]ibrary|[S]ystem|private|v[a]r|tmp|Volumes|home|[e]tc|[o]pt)(?:\/|$)|\/[u]sr\/local(?:\/|$)|[A-Za-z]:\\(?:[U]sers|Documents|Windows|Program[D]ata)(?:\\|$)|\\\\[^\\\s]+\\[^\\\s]+)`,
  'i',
);
const IPV4_PATTERN = /(?:^|[^0-9])((?:\d{1,3}\.){3}\d{1,3})(?=[^0-9]|$)/g;
const IPV6_PATTERN = /(?:^|[^A-Fa-f0-9:])((?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4})(?=[^A-Fa-f0-9:]|$)/g;
const ENDPOINT_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g;
const HOST_PATTERN = /(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+/g;
const SOURCE_FILE_SUFFIXES = new Set(['css', 'html', 'js', 'json', 'lock', 'md', 'mjs', 'cjs', 'txt', 'yaml', 'yml']);
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
const LOCATOR_PATTERNS = Object.freeze([
  /key[c]hain/i,
  /find-[g]eneric-password/i,
  /login[I]dentifier/i,
  /user[I]d/i,
  /member[I]d/i,
  /api[K]ey/i,
  /access[K]ey/i,
  /authoriz[a]tion/i,
  /recovery\s*[c]ode/i,
  /bearer\s+[A-Za-z0-9._-]+/i,
]);
const PRIVATE_KEY_MARKER_PATTERN = /-{5}(?:BEGIN|END)\s+(?:(?:RSA|EC|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-{5}/i;

function identifierTokens(value) {
  return String(value || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function containsTokenSequence(tokens, sequence) {
  if (sequence.length > tokens.length) return false;
  for (let offset = 0; offset <= tokens.length - sequence.length; offset += 1) {
    if (sequence.every((token, index) => tokens[offset + index] === token)) return true;
  }
  return false;
}

function sensitiveFieldIssue(value) {
  const tokens = identifierTokens(value);
  if (tokens.length === 0) return null;
  const compact = tokens.join('');
  return SENSITIVE_COMPACT_FIELDS.has(compact)
    || tokens.some((token) => SENSITIVE_FIELD_TOKENS.has(token))
    || SENSITIVE_FIELD_SEQUENCES.some((sequence) => containsTokenSequence(tokens, sequence))
    ? 'private identity or credential field'
    : null;
}

function ipv4Parts(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isNonPublicIpv4(value) {
  const parts = ipv4Parts(value);
  if (!parts) return true;
  const [first, second, third] = parts;
  return first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113);
}

function isIpv6Literal(value) {
  return isIP(String(value || '').toLowerCase()) === 6;
}

function isInternalHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === LOCALHOST || normalized.endsWith('.local')
    || normalized.endsWith('.lan') || normalized.endsWith('.internal')
    || normalized.endsWith('.corp') || normalized.includes(COMPANY_HOST_FRAGMENT)) {
    return true;
  }
  if (normalized.includes(':')) return true;
  const ipv4 = ipv4Parts(normalized);
  if (ipv4) return isNonPublicIpv4(normalized);
  return normalized.split('.').some((label) => INTERNAL_HOST_LABELS.has(label));
}

function endpointIssue(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return 'invalid endpoint';
  }
  if (parsed.protocol === 'file:' || parsed.protocol === 'http:') return 'local or insecure endpoint';
  if (parsed.username || parsed.password || parsed.port) return 'credential-bearing or custom-port endpoint';
  if (isInternalHostname(parsed.hostname)) return 'company, internal, or non-public endpoint';
  if ([...parsed.searchParams.keys()].some((key) => sensitiveFieldIssue(key))) {
    return 'endpoint contains private query fields';
  }
  return null;
}

function stringIpv4Issue(value) {
  IPV4_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(IPV4_PATTERN)) {
    if (isNonPublicIpv4(match[1])) return 'non-public IP address';
  }
  return null;
}

function stringIpv6Issue(value) {
  IPV6_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(IPV6_PATTERN)) {
    if (isIpv6Literal(match[1])) return 'IPv6 address is not allowed';
  }
  return null;
}

function sensitiveStringIssue(value) {
  if (typeof value !== 'string') return null;
  if (SYSTEM_PATH_PATTERN.test(value)) return 'machine-specific or system path';
  const addressIssue = stringIpv4Issue(value);
  if (addressIssue) return addressIssue;
  const ipv6Issue = stringIpv6Issue(value);
  if (ipv6Issue) return ipv6Issue;
  if (EMAIL_PATTERN.test(value)) return 'login or email identifier';
  if (LOCATOR_PATTERNS.some((pattern) => pattern.test(value))) return 'identity or credential locator';
  if (PRIVATE_KEY_MARKER_PATTERN.test(value)) return 'private-key material';

  const endpoints = value.match(ENDPOINT_PATTERN) || [];
  for (const endpoint of endpoints) {
    const issue = endpointIssue(endpoint);
    if (issue) return issue;
  }
  const hosts = value.match(HOST_PATTERN) || [];
  for (const host of hosts) {
    const suffix = host.toLowerCase().split('.').at(-1);
    if (!SOURCE_FILE_SUFFIXES.has(suffix) && isInternalHostname(host)) {
      return 'company or internal hostname';
    }
  }
  return null;
}

function structuredValueIssues(value, label = 'value', issues = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => structuredValueIssues(item, `${label}[${index}]`, issues));
    return issues;
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const issue = sensitiveStringIssue(value);
      if (issue) issues.push(`${label}: ${issue}`);
    }
    return issues;
  }
  for (const [key, item] of Object.entries(value)) {
    const fieldIssue = sensitiveFieldIssue(key);
    if (fieldIssue) issues.push(`${label}: ${fieldIssue}`);
    const itemLabel = fieldIssue ? `${label}.<redacted>` : `${label}.${key}`;
    if ((key === 'name' || key === 'queryName')
      && typeof item === 'string'
      && sensitiveFieldIssue(item)) {
      issues.push(`${itemLabel}: private identity or credential parameter`);
    }
    structuredValueIssues(item, itemLabel, issues);
  }
  return issues;
}

function sourceContentIssues(content) {
  const issues = new Set();
  if (SYSTEM_PATH_PATTERN.test(content)) issues.add('machine-specific or system path');
  const addressIssue = stringIpv4Issue(content);
  if (addressIssue) issues.add(addressIssue);
  const ipv6Issue = stringIpv6Issue(content);
  if (ipv6Issue) issues.add(ipv6Issue);
  if (EMAIL_PATTERN.test(content)) issues.add('login or email identifier');
  if (PRIVATE_KEY_MARKER_PATTERN.test(content)) issues.add('private-key material');

  const endpoints = content.match(ENDPOINT_PATTERN) || [];
  for (const endpoint of endpoints) {
    const issue = endpointIssue(endpoint);
    if (issue) issues.add(issue);
  }
  if (/key[c]hain(?:Account|Service)/i.test(content)
    || /find-[g]eneric-password/i.test(content)
    || /login[I]dentifier/i.test(content)) {
    issues.add('identity or credential locator');
  }

  const quotedFieldPattern = /["']([A-Za-z][A-Za-z0-9_.-]*)["']\s*:/g;
  for (const match of content.matchAll(quotedFieldPattern)) {
    const issue = sensitiveFieldIssue(match[1]);
    if (issue) issues.add(issue);
  }
  const quotedTextPattern = /["']([^"'\\\r\n]*(?:\\.[^"'\\\r\n]*)*)["']/g;
  for (const match of content.matchAll(quotedTextPattern)) {
    const hosts = match[1].match(HOST_PATTERN) || [];
    for (const host of hosts) {
      const suffix = host.toLowerCase().split('.').at(-1);
      if (!SOURCE_FILE_SUFFIXES.has(suffix) && isInternalHostname(host)) {
        issues.add('company or internal hostname');
      }
    }
  }
  return [...issues];
}

module.exports = {
  endpointIssue,
  isInternalHostname,
  isNonPublicIpv4,
  isIpv6Literal,
  sensitiveFieldIssue,
  sensitiveStringIssue,
  sourceContentIssues,
  structuredValueIssues,
};
