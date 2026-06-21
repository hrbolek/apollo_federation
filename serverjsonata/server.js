// server.js
import express from "express";
import { parse, Kind } from "graphql";

import {
  EndpointRegistry,
  applySelectionSet,
  buildUrlFromTemplate,
  evaluateJsonata
} from "./endpointRegistry.js";

const app = express();
app.use(express.json());

const registry = new EndpointRegistry();

/**
 * Demo endpoint 1:
 *
 * Klient používá:
 *   id, name, city
 *
 * Upstream vrací:
 *   user_id, full_name, address.city
 */
registry.register({
  name: "userById",
  method: "GET",
  urlTemplate: "https://example.com/api/users/{id}",

  selectionMap: {
    id: "user_id",
    name: "full_name",
    city: "address.city",
    age: "age"
  }
});

/**
 * Demo endpoint 2:
 *
 * Tady se nejdřív normalizuje root response přes responseTransform.
 * Selection set se pak aplikuje už na normalizovanou odpověď.
 */
registry.register({
  name: "userSearch",
  method: "POST",
  url: "https://example.com/api/users/search",

  requestTransform: `{
    "search": args.term,
    "limit": args.limit ? args.limit : 20
  }`,

  responseTransform: `{
    "items": users.{
      "id": user_id,
      "name": full_name,
      "city": address.city
    },
    "total": total_count
  }`,

  selectionMap: {
    items: {
      path: "items",
      fields: {
        id: "id",
        name: "name",
        city: "city"
      }
    },
    total: "total"
  }
});

app.post("/graphql", async (req, res) => {
  try {
    const { query, variables = {} } = req.body;

    if (!query) {
      return res.status(400).json({
        errors: [{ message: "Missing 'query' in request body." }]
      });
    }

    const document = parse(query);
    const operation = getOperation(document);

    if (!operation) {
      return res.status(400).json({
        errors: [{ message: "No GraphQL operation found." }]
      });
    }

    const data = {};

    for (const rootSelection of operation.selectionSet.selections) {
      if (rootSelection.kind !== Kind.FIELD) {
        continue;
      }

      const endpointName = rootSelection.name.value;
      const responseFieldName = rootSelection.alias?.value ?? endpointName;

      const endpoint = registry.get(endpointName);

      if (!endpoint) {
        data[responseFieldName] = null;
        continue;
      }

      const args = readArguments(rootSelection.arguments ?? [], variables);

      const upstreamRaw = await callEndpoint(endpoint, args, variables);

      const transformed = endpoint.responseTransform
        ? await evaluateJsonata(endpoint.responseTransform, upstreamRaw)
        : upstreamRaw;

      const selected = await applySelectionSet(
        transformed,
        rootSelection.selectionSet,
        endpoint.selectionMap
      );

      data[responseFieldName] = selected;
    }

    return res.json({ data });
  } catch (error) {
    return res.status(500).json({
      errors: [
        {
          message: error.message
        }
      ]
    });
  }
});

function getOperation(document) {
  return document.definitions.find(
    definition => definition.kind === Kind.OPERATION_DEFINITION
  );
}

async function callEndpoint(endpoint, args, variables) {
  const url =
    endpoint.buildUrl?.(args, variables) ??
    buildUrlFromTemplate(endpoint.urlTemplate, args) ??
    endpoint.url;

  if (!url) {
    throw new Error(`Endpoint '${endpoint.name}' has no URL.`);
  }

  const method = endpoint.method ?? "GET";

  const headers = {
    "content-type": "application/json",
    ...(endpoint.headers ?? {})
  };

  const fetchOptions = {
    method,
    headers
  };

  if (method !== "GET" && method !== "HEAD") {
    let body;

    if (endpoint.buildBody) {
      body = endpoint.buildBody(args, variables);
    } else if (endpoint.requestTransform) {
      body = await evaluateJsonata(endpoint.requestTransform, {
        args,
        variables
      });
    } else {
      body = args;
    }

    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);

  const text = await response.text();

  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Endpoint '${endpoint.name}' did not return valid JSON. Status: ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Endpoint '${endpoint.name}' failed with status ${response.status}: ${JSON.stringify(json)}`
    );
  }

  return json;
}

function readArguments(args, variables) {
  const result = {};

  for (const arg of args) {
    result[arg.name.value] = readValue(arg.value, variables);
  }

  return result;
}

function readValue(node, variables) {
  switch (node.kind) {
    case Kind.VARIABLE:
      return variables[node.name.value];

    case Kind.STRING:
    case Kind.ENUM:
      return node.value;

    case Kind.INT:
      return Number.parseInt(node.value, 10);

    case Kind.FLOAT:
      return Number.parseFloat(node.value);

    case Kind.BOOLEAN:
      return node.value;

    case Kind.NULL:
      return null;

    case Kind.LIST:
      return node.values.map(value => readValue(value, variables));

    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map(field => [
          field.name.value,
          readValue(field.value, variables)
        ])
      );

    default:
      throw new Error(`Unsupported GraphQL value kind '${node.kind}'.`);
  }
}

const port = process.env.PORT ?? 3000;

app.listen(port, () => {
  console.log(`CatchAll API gateway listening on http://localhost:${port}/graphql`);
});