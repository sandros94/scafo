/**
 * Deterministic `JSON.stringify`: object keys are sorted recursively, arrays keep
 * their order. Two structurally equal values always produce byte-identical
 * output, which is what makes stored records safe to compare and hash.
 *
 * Differences from `JSON.stringify`: a top-level `undefined`, function or symbol
 * throws a `TypeError` instead of returning `undefined`. Object properties
 * holding those values are skipped, and array holes become `null`, as usual.
 */
export function stableStringify(value: unknown): string {
  const json = serialize(value, new WeakSet<object>());
  if (json === undefined) {
    throw new TypeError(`stableStringify cannot serialize a top-level ${typeof value}`);
  }
  return json;
}

function serialize(input: unknown, seen: WeakSet<object>): string | undefined {
  const value = toJsonValue(input);

  if (value === null) return "null";
  switch (typeof value) {
    case "string": {
      return JSON.stringify(value);
    }
    case "number": {
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    }
    case "boolean": {
      return value ? "true" : "false";
    }
    case "bigint": {
      throw new TypeError("stableStringify cannot serialize a BigInt");
    }
    case "object": {
      break;
    }
    default: {
      return undefined;
    }
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError("stableStringify cannot serialize circular structures");
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      const items = object.map((item) => serialize(item, seen) ?? "null");
      return `[${items.join(",")}]`;
    }

    const record = object as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const json = serialize(record[key], seen);
      if (json !== undefined) entries.push(`${JSON.stringify(key)}:${json}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

function toJsonValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "toJSON" in value) {
    const { toJSON } = value as { toJSON: unknown };
    if (typeof toJSON === "function") return (toJSON as () => unknown).call(value);
  }
  return value;
}
