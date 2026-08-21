'use strict';

const { ContractError } = require('./errors');

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function parseJsonStrict(text, label = 'JSON input', code = 'INVALID_SOURCE_BUNDLE') {
  if (typeof text !== 'string') throw new ContractError(code, `${label} must be text`);
  let index = 0;

  function fail() {
    throw new ContractError(code, `${label} must contain valid JSON`);
  }

  function skipWhitespace() {
    while (index < text.length && /[\u0020\u000a\u000d\u0009]/.test(text[index])) index += 1;
  }

  function parseString() {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail();
        }
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/.test(text[index])) fail();
        if (text[index] === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(index + 1, index + 5))) fail();
          index += 4;
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail();
      }
      index += 1;
    }
    fail();
    return '';
  }

  function parseLiteral(literal) {
    if (text.slice(index, index + literal.length) !== literal) fail();
    index += literal.length;
  }

  function parseNumber() {
    const match = text.slice(index).match(NUMBER_PATTERN);
    if (!match) fail();
    index += match[0].length;
  }

  function parseArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      if (text[index] !== ',') fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseObject() {
    index += 1;
    skipWhitespace();
    const members = new Set();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    while (index < text.length) {
      const member = parseString();
      if (members.has(member)) {
        throw new ContractError('DUPLICATE_JSON_MEMBER', `${label} contains a duplicate object member`);
      }
      members.add(member);
      skipWhitespace();
      if (text[index] !== ':') fail();
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      if (text[index] !== ',') fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseValue() {
    skipWhitespace();
    const character = text[index];
    if (character === '{') parseObject();
    else if (character === '[') parseArray();
    else if (character === '"') parseString();
    else if (character === 't') parseLiteral('true');
    else if (character === 'f') parseLiteral('false');
    else if (character === 'n') parseLiteral('null');
    else if (character === '-' || /[0-9]/.test(character || '')) parseNumber();
    else fail();
  }

  parseValue();
  skipWhitespace();
  if (index !== text.length) fail();
  try {
    return JSON.parse(text);
  } catch {
    fail();
    return null;
  }
}

module.exports = { parseJsonStrict };
