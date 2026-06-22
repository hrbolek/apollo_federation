import jsonata from "jsonata";

/**
 * Registry for API endpoint configurations.
 *
 * Example endpoint config:
 *
 * {
 *   "name": "userById",
 *   "method": "GET",
 *   "urlTemplate": "https://example.com/api/users/{id}",
 *   "headers": {
 *     "x-api-key": "secret"
 *   },
 *   "responseTransform": "{ \"id\": user_id, \"name\": full_name }",
 *   "selectionMap": {
 *     "id": "user_id",
 *     "name": "full_name",
 *     "city": "address.city"
 *   }
 * }
 *
 * For POST-like endpoints:
 *
 * {
 *   "name": "userSearch",
 *   "method": "POST",
 *   "url": "https://example.com/api/users/search",
 *   "requestTransform": "{ \"search\": args.term, \"limit\": args.limit ? args.limit : 20 }",
 *   "responseTransform": "{ \"items\": users.{ \"id\": user_id, \"name\": full_name }, \"total\": total_count }",
 *   "selectionMap": {
 *     "items": {
 *       "path": "items",
 *       "fields": {
 *         "id": "id",
 *         "name": "name"
 *       }
 *     },
 *     "total": "total"
 *   }
 * }
 */
export class EndpointRegistry {
  constructor() {
    this.endpoints = new Map();
  }

  register(config) {
    validateEndpointConfig(config);

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

  size() {
    return this.endpoints.size;
  }

  list() {
    return Array.from(this.endpoints.values());
  }
}

function validateEndpointConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Endpoint config must be an object.");
  }

  if (!config.name || typeof config.name !== "string") {
    throw new Error("Endpoint config must have a string property 'name'.");
  }

  if (!config.url && !config.urlTemplate) {
    throw new Error(
      `Endpoint '${config.name}' must have either 'url' or 'urlTemplate'.`
    );
  }

  if (config.method && typeof config.method !== "string") {
    throw new Error(`Endpoint '${config.name}' property 'method' must be a string.`);
  }

  if (config.headers && typeof config.headers !== "object") {
    throw new Error(`Endpoint '${config.name}' property 'headers' must be an object.`);
  }

  if (config.requestTransform && typeof config.requestTransform !== "string") {
    throw new Error(
      `Endpoint '${config.name}' property 'requestTransform' must be a JSONata string.`
    );
  }

  if (config.responseTransform && typeof config.responseTransform !== "string") {
    throw new Error(
      `Endpoint '${config.name}' property 'responseTransform' must be a JSONata string.`
    );
  }

  if (config.selectionMap && typeof config.selectionMap !== "object") {
    throw new Error(
      `Endpoint '${config.name}' property 'selectionMap' must be an object.`
    );
  }
}

/**
 * Replaces placeholders in URL templates.
 *
 * Example:
 *
 * buildUrlFromTemplate(
 *   "https://example.com/users/{id}/orders/{orderId}",
 *   { id: 10, orderId: 20 }
 * )
 *
 * -> "https://example.com/users/10/orders/20"
 */
export function buildUrlFromTemplate(template, args = {}) {
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

/**
 * Evaluates a JSONata expression.
 *
 * The caller decides what input object is used. Typical inputs:
 *
 * responseTransform:
 *   input = upstream JSON response
 *
 * requestTransform:
 *   input = { args, variables }
 */
export async function evaluateJsonata(expressionText, input) {
  if (!expressionText) {
    return input;
  }

  const expression = jsonata(expressionText);
  return await expression.evaluate(input);
}

/**
 * Applies a GraphQL selection set to a JSON object.
 *
 * If selectionMap is provided, public GraphQL field names can be mapped
 * to different upstream/internal field names or JSONata expressions.
 *
 * Example query:
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
 * Output:
 *
 * {
 *   "id": 1,
 *   "displayName": "Jan Novak",
 *   "city": "Brno"
 * }
 */
export async function applySelectionSet(data, selectionSet, selectionMap) {
  if (!selectionSet) {
    return data;
  }

  if (Array.isArray(data)) {
    const selectedItems = [];

    for (const item of data) {
      selectedItems.push(await applySelectionSet(item, selectionSet, selectionMap));
    }

    return selectedItems;
  }

  if (data === null || data === undefined) {
    return data;
  }

  if (!selectionMap) {
    return projectPlainSelection(data, selectionSet);
  }

  const expressionText = buildJsonataFromSelectionSet(selectionSet, selectionMap);
  return await evaluateJsonata(expressionText, data);
}

/**
 * Builds a JSONata object expression from a GraphQL selection set.
 *
 * Supported selectionMap forms:
 *
 * 1. Simple field/expression:
 *
 * {
 *   "name": "full_name"
 * }
 *
 * 2. Nested object:
 *
 * {
 *   "address": {
 *     "path": "address",
 *     "fields": {
 *       "street": "street_name",
 *       "city": "city_name"
 *     }
 *   }
 * }
 *
 * 3. Array of objects:
 *
 * If the mapped path points to an array, JSONata automatically maps
 * object construction over array items:
 *
 * {
 *   "items": {
 *     "path": "users",
 *     "fields": {
 *       "id": "user_id",
 *       "name": "full_name"
 *     }
 *   }
 * }
 */
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
      if (selection.selectionSet) {
        const nestedExpression = buildJsonataFromSelectionSet(
          selection.selectionSet,
          {}
        );

        entries.push(
          `${jsonString(outputFieldName)}: ${publicFieldName}.${nestedExpression}`
        );
      } else {
        entries.push(`${jsonString(outputFieldName)}: ${publicFieldName}`);
      }

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

    throw new Error(
      `Unsupported selection mapping for field '${publicFieldName}'.`
    );
  }

  return `{ ${entries.join(", ")} }`;
}

/**
 * Plain projection used when no selectionMap is configured.
 * It only copies requested fields by their existing names.
 */
function projectPlainSelection(data, selectionSet) {
  if (Array.isArray(data)) {
    return data.map(item => projectPlainSelection(item, selectionSet));
  }

  if (data === null || data === undefined || typeof data !== "object") {
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
      result[outputFieldName] = projectPlainSelection(
        value,
        selection.selectionSet
      );
    } else {
      result[outputFieldName] = value;
    }
  }

  return result;
}

function jsonString(value) {
  return JSON.stringify(value);
}