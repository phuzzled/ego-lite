/**
 * A small JSON Schema validator for MCP tool inputs. It covers the subset the
 * tool schemas use: type, properties, required, additionalProperties: false,
 * enum, minimum, maximum, minLength, maxLength, items, minItems and anyOf.
 *
 * validate(schema, value) returns a list of messages; empty means valid.
 */

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

export function validate(schema, value, path = "arguments") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (schema.anyOf) {
    const passes = schema.anyOf.some(
      (option) => validate(option, value, path).length === 0,
    );
    if (!passes) {
      const kinds = schema.anyOf
        .map((option) => option.type ?? JSON.stringify(option.enum ?? option))
        .join(" or ");
      errors.push(`${path} must be ${kinds}`);
    }
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push(
        `${path} must be ${types.join(" or ")}, not ${typeOf(value)}`,
      );
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    );
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(
        schema.minLength === 1
          ? `${path} must not be empty`
          : `${path} must have at least ${schema.minLength} characters`,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must have at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must have at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validate(schema.items, item, `${path}[${index}]`));
      });
    }
  }

  if (typeOf(value) === "object") {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) errors.push(`${path}.${name} is required`);
    }
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        errors.push(...validate(properties[name], item, `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        errors.push(
          `${path}.${name} is not a known argument (known: ${Object.keys(properties).join(", ") || "none"})`,
        );
      }
    }
  }
  return errors;
}
