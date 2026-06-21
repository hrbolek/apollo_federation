// endpointRegistry.js
import jsonata from "jsonata";

/**
 * Registr endpointů.
 *
 * Endpoint config může mít:
 *
 * {
 *   name: "userById",
 *   method: "GET",
 *   urlTemplate: "https://api.example.com/users/{id}",
 *
 *   // volitelně: JSONata nad { args, variables }
 *   requestTransform: `{
 *     "search": args.term,
 *     "limit": args.limit ? args.limit : 20
 *   }`,
 *
 *   // volitelně: JSONata nad raw upstream odpovědí
 *   responseTransform: `{
 *     "id": user_id,
 *     "name": full_name,
 *     "address": address
 *   }`,
 *
 *   // mapování GraphQL selection setu na JSONata výrazy
 *   selectionMap: {
 *     id: "user_id",
 *     name: "full_name",
 *     city: "address.city",
 *     address: {
 *       path: "address",
 *       fields: {
 *         street: "street_name",
 *         city: "city_name"
 *       }
 *     }
 *   }
 * }
 */
export class EndpointRegistry {
  constructor() {
    this.endpoints = new Map();
  }

  register(config) {
    if (!config?.name) {
      throw new Error("Endpoint config must have a name.");
    }

    if (this.endpoints.has(config.name)) {
      throw new Error(`Endpoint '${config.name}' is already registered.`);
    }

    this.endpoints.set(config.name, {
      method: "GET",
      headers: {},
      ...config
    });
  }

  get(name) {
    return this.endpoints.get(name);
  }

  has(name) {
    return this.endpoints.has(name);
  }
}

export function buildUrlFromTemplate(template, args) {
  if (!template) {
    return undefined;
  }

  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = args[key];

    if (value === undefined || value === null) {
      throw new Error(`Missing URL template argument '${key}'.`);
    }

    return encodeURIComponent(String(value));
  });
}

export async function evaluateJsonata(expressionText, input) {
  if (!expressionText) {
    return input;
  }

  const expression = jsonata(expressionText);
  return await expression.evaluate(input);
}

/**
 * Aplikuje selection set.
 *
 * Když endpoint má selectionMap, vygeneruje se JSONata objekt podle toho,
 * co klient skutečně požaduje.
 *
 * Příklad query:
 *
 * query {
 *   userById(id: 1) {
 *     id
 *     displayName: name
 *     city
 *   }
 * }
 *
 * selectionMap:
 *
 * {
 *   id: "user_id",
 *   name: "full_name",
 *   city: "address.city"
 * }
 *
 * Výstup:
 *
 * {
 *   id: ...,
 *   displayName: ...,
 *   city: ...
 * }
 */
export async function applySelectionSet(data, selectionSet, selectionMap) {
  if (!selectionSet) {
    return data;
  }

  if (!selectionMap) {
    return projectPlainSelection(data, selectionSet);
  }

  const expressionText = buildJsonataFromSelectionSet(selectionSet, selectionMap);
  return await evaluateJsonata(expressionText, data);
}

function buildJsonataFromSelectionSet(selectionSet, selectionMap) {
  const entries = [];

  for (const selection of selectionSet.selections) {
    if (selection.kind !== "Field") {
      continue;
    }

    const publicFieldName = selection.name.value;
    const outputFieldName = selection.alias?.value ?? publicFieldName;
    const mapping = selectionMap[publicFieldName];

    if (!mapping) {
      // Fallback: když mapping neexistuje, použije se stejné jméno.
      entries.push(`${jsonString(outputFieldName)}: ${publicFieldName}`);
      continue;
    }

    if (typeof mapping === "string") {
      if (selection.selectionSet) {
        const nestedExpression = buildJsonataFromSelectionSet(
          selection.selectionSet,
          {}
        );

        entries.push(
          `${jsonString(outputFieldName)}: ${mapping}.${nestedExpression}`
        );
      } else {
        entries.push(`${jsonString(outputFieldName)}: ${mapping}`);
      }

      continue;
    }

    if (typeof mapping === "object") {
      const path = mapping.path ?? publicFieldName;
      const nestedMap = mapping.fields ?? {};

      if (selection.selectionSet) {
        const nestedExpression = buildJsonataFromSelectionSet(
          selection.selectionSet,
          nestedMap
        );

        entries.push(
          `${jsonString(outputFieldName)}: ${path}.${nestedExpression}`
        );
      } else {
        entries.push(`${jsonString(outputFieldName)}: ${path}`);
      }

      continue;
    }

    throw new Error(`Unsupported selection mapping for field '${publicFieldName}'.`);
  }

  return `{ ${entries.join(", ")} }`;
}

function projectPlainSelection(data, selectionSet) {
  if (Array.isArray(data)) {
    return data.map(item => projectPlainSelection(item, selectionSet));
  }

  if (data === null || typeof data !== "object") {
    return data;
  }

  const result = {};

  for (const selection of selectionSet.selections) {
    if (selection.kind !== "Field") {
      continue;
    }

    const publicFieldName = selection.name.value;
    const outputFieldName = selection.alias?.value ?? publicFieldName;
    const value = data[publicFieldName];

    if (selection.selectionSet) {
      result[outputFieldName] = projectPlainSelection(value, selection.selectionSet);
    } else {
      result[outputFieldName] = value;
    }
  }

  return result;
}

function jsonString(value) {
  return JSON.stringify(value);
}