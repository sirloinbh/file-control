'use strict';

// 결과 객체를 JSON으로 옮길 수 있는 값으로 바꾼다(#253).
// Error → { name, message, code, ... }, Set → 배열, Map → [키, 값] 배열, BigInt → 글자, Buffer → 글자(utf8),
// Date → ISO 글자, undefined·함수·심볼은 객체 안에서는 빼고 배열 안에서는 null로 둔다. 같은 객체를 다시 만나면 '[순환]'으로 둔다.
function toPlain(value, seen = new Set()) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (seen.has(value)) return '[순환]';
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Error) {
      // FcError처럼 name을 바꾸지 않은 하위 클래스도 화면에서 구분할 수 있게 클래스 이름을 쓴다.
      const name = value.name === 'Error' && value.constructor && value.constructor.name ? value.constructor.name : value.name;
      const plain = { name, message: value.message };
      for (const key of Object.keys(value)) {
        const item = toPlain(value[key], seen);
        if (item !== undefined) plain[key] = item;
      }
      return plain;
    }
    if (value instanceof Set) return [...value].map((item) => inArray(item, seen));
    if (value instanceof Map) return [...value].map(([k, v]) => [inArray(k, seen), inArray(v, seen)]);
    if (Array.isArray(value)) return value.map((item) => inArray(item, seen));
    const plain = {};
    for (const key of Object.keys(value)) {
      const item = toPlain(value[key], seen);
      if (item !== undefined) plain[key] = item;
    }
    return plain;
  } finally {
    // 같은 객체가 여러 곳에 나오는 것(순환이 아닌 공유)은 그대로 옮긴다.
    seen.delete(value);
  }
}

function inArray(item, seen) {
  const plain = toPlain(item, seen);
  return plain === undefined ? null : plain;
}

module.exports = { toPlain };
