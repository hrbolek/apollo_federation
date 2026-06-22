import express from "express";
import fs from "node:fs";
import { parse, Kind } from "graphql";

import {
    EndpointRegistry,
    applySelectionSet,
    buildUrlFromTemplate,
    evaluateJsonata
} from "./endpointRegistry.js";

const app = express();

app.use(express.json({
    limit: process.env.JSON_BODY_LIMIT ?? "1mb"
}));

const registry = new EndpointRegistry();

loadEndpointsFromConfiguration(registry);

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        method: "GET",
        endpoints: registry.size?.() ?? undefined,
        forwardedHeaders: getAllowedForwardHeaders()
    });
});

app.post("/health", (req, res) => {
    res.json({
        ok: true,
        method: "POST",
        endpoints: registry.size?.() ?? undefined,
        forwardedHeaders: getAllowedForwardHeaders(),
        payload: req.body ?? null
    });
});

app.get("/debug", async (_req, res) => {
    const payload = {
        query:
            "query { first: healthOne(id: 1, name: \"Test\", value: 123) { isOk: ok endpoint: service requestMethod: method renamedId: id renamedName: name renamedValue: value } }"
    };

    const headers = {
        "content-type": "application/json",
        "authorization": "Bearer test-token"
    };

    try {
        const port = Number(process.env.PORT ?? 3000);
        const url = `http://localhost:${port}/graphql`;

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });

        const text = await response.text();

        let result;

        try {
            result = text ? JSON.parse(text) : null;
        } catch {
            result = text;
        }

        return res.status(response.ok ? 200 : response.status).json({
            ok: response.ok,
            debugRequest: {
                url,
                method: "POST",
                headers,
                payload
            },
            debugResponse: {
                status: response.status,
                body: result
            }
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            error: error.message,
            debugRequest: {
                method: "POST",
                headers,
                payload
            }
        });
    }
});

app.get("/debug/query", async (req, res) => {
    const query = req.query.query;

    if (!query || typeof query !== "string") {
        return res.status(400).json({
            ok: false,
            error: "Missing required query parameter 'query'.",
            example:
                "/debug/query?query=query%20%7B%20first%3A%20healthOne(id%3A%201%2C%20name%3A%20%5C%22Test%5C%22%2C%20value%3A%20123)%20%7B%20isOk%3A%20ok%20endpoint%3A%20service%20%7D%20%7D"
        });
    }

    let variables = {};

    const variablesRaw = req.query.variables ?? req.query.vars;

    if (variablesRaw !== undefined) {
        if (typeof variablesRaw !== "string") {
            return res.status(400).json({
                ok: false,
                error: "Query parameter 'variables' or 'vars' must be a JSON string."
            });
        }

        try {
            variables = JSON.parse(variablesRaw);
        } catch (error) {
            return res.status(400).json({
                ok: false,
                error: `Invalid variables JSON: ${error.message}`,
                received: variablesRaw
            });
        }
    }

    const operationName =
        typeof req.query.operationName === "string"
            ? req.query.operationName
            : undefined;

    const payload = {
        query,
        variables
    };

    if (operationName) {
        payload.operationName = operationName;
    }

    const headers = {
        "content-type": "application/json",
        "authorization":
            typeof req.query.authorization === "string"
                ? req.query.authorization
                : "Bearer test-token"
    };

    if (typeof req.query.cookie === "string") {
        headers.cookie = req.query.cookie;
    }

    if (typeof req.query.acceptLanguage === "string") {
        headers["accept-language"] = req.query.acceptLanguage;
    }

    if (typeof req.query.requestId === "string") {
        headers["x-request-id"] = req.query.requestId;
    }

    try {
        const port = Number(process.env.PORT ?? 3000);
        const url = `http://localhost:${port}/graphql`;

        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });

        const text = await response.text();

        let result;

        try {
            result = text ? JSON.parse(text) : null;
        } catch {
            result = text;
        }

        return res.status(response.ok ? 200 : response.status).json({
            ok: response.ok,
            debugRequest: {
                url,
                method: "POST",
                headers,
                payload
            },
            debugResponse: {
                status: response.status,
                body: result
            }
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            error: error.message,
            debugRequest: {
                method: "POST",
                headers,
                payload
            }
        });
    }
});

app.post("/graphql", async (req, res) => {
    try {
        const { query, variables = {}, operationName } = req.body ?? {};

        if (!query) {
            return res.status(400).json({
                errors: [
                    {
                        message: "Missing 'query' in request body."
                    }
                ]
            });
        }

        const document = parse(query);
        const operation = getOperation(document, operationName);

        if (!operation) {
            return res.status(400).json({
                errors: [
                    {
                        message: operationName
                            ? `No GraphQL operation named '${operationName}' found.`
                            : "No GraphQL operation found."
                    }
                ]
            });
        }

        const data = {};
        const errors = [];

        for (const rootSelection of operation.selectionSet.selections) {
            if (rootSelection.kind !== Kind.FIELD) {
                continue;
            }

            const endpointName = rootSelection.name.value;
            const responseFieldName = rootSelection.alias?.value ?? endpointName;

            const endpoint = registry.get(endpointName);

            if (!endpoint) {
                data[responseFieldName] = null;
                errors.push({
                    message: `Endpoint '${endpointName}' is not registered.`,
                    path: [responseFieldName]
                });
                continue;
            }

            try {
                const args = readArguments(rootSelection.arguments ?? [], variables);

                const upstreamRaw = await callEndpoint(
                    endpoint,
                    args,
                    variables,
                    req.headers
                );

                const transformed = endpoint.responseTransform
                    ? await evaluateJsonata(endpoint.responseTransform, upstreamRaw)
                    : upstreamRaw;

                const selected = await applySelectionSet(
                    transformed,
                    rootSelection.selectionSet,
                    endpoint.selectionMap
                );

                data[responseFieldName] = selected;
            } catch (error) {
                data[responseFieldName] = null;
                errors.push({
                    message: error.message,
                    path: [responseFieldName]
                });
            }
        }

        const responseBody = { data };

        if (errors.length > 0) {
            responseBody.errors = errors;
        }

        return res.status(errors.length > 0 ? 207 : 200).json(responseBody);
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

function loadEndpointsFromConfiguration(registry) {
    const raw = readEndpointConfiguration();

    if (!raw) {
        console.warn(
            "No endpoint configuration found. Set ENDPOINTS_JSON or ENDPOINTS_CONFIG_PATH."
        );
        return;
    }

    let configs;

    try {
        configs = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid endpoint configuration JSON: ${error.message}`);
    }

    if (!Array.isArray(configs)) {
        throw new Error("Endpoint configuration must be a JSON array.");
    }

    for (const config of configs) {
        registry.register(config);
    }

    console.log(`Registered ${configs.length} endpoint(s).`);
}

function readEndpointConfiguration() {
    if (process.env.ENDPOINTS_JSON) {
        console.log("Loading endpoint configuration from ENDPOINTS_JSON.");
        return process.env.ENDPOINTS_JSON;
    }

    if (process.env.ENDPOINTS_CONFIG_PATH) {
        const configPath = process.env.ENDPOINTS_CONFIG_PATH;

        console.log(`Loading endpoint configuration from file: ${configPath}`);

        if (!fs.existsSync(configPath)) {
            throw new Error(
                `ENDPOINTS_CONFIG_PATH points to a non-existing file: ${configPath}`
            );
        }

        return fs.readFileSync(configPath, "utf8");
    }

    return undefined;
}

function getOperation(document, operationName) {
    const operations = document.definitions.filter(
        definition => definition.kind === Kind.OPERATION_DEFINITION
    );

    if (operationName) {
        return operations.find(
            operation => operation.name?.value === operationName
        );
    }

    if (operations.length === 1) {
        return operations[0];
    }

    return operations.find(operation => !operation.name);
}

async function callEndpoint(endpoint, args, variables, incomingHeaders = {}) {
    const url =
        endpoint.buildUrl?.(args, variables) ??
        buildUrlFromTemplate(endpoint.urlTemplate, args) ??
        endpoint.url;

    if (!url) {
        throw new Error(`Endpoint '${endpoint.name}' has no URL.`);
    }

    const method = (endpoint.method ?? "GET").toUpperCase();

    const headers = buildForwardHeaders(endpoint, incomingHeaders);

    const fetchOptions = {
        method,
        headers
    };

    if (method !== "GET" && method !== "HEAD") {
        let body;

        if (endpoint.requestTransform) {
            body = await evaluateJsonata(endpoint.requestTransform, {
                args,
                variables
            });
        } else if (endpoint.body !== undefined) {
            body = endpoint.body;
        } else {
            body = args;
        }

        fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    let payload;

    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(
            `Endpoint '${endpoint.name}' did not return valid JSON. Status: ${response.status}`
        );
    }

    if (!response.ok) {
        throw new Error(
            `Endpoint '${endpoint.name}' failed with status ${response.status}: ${JSON.stringify(payload)}`
        );
    }

    return payload;
}

/**
 * Header forwarding is intentionally controlled by a global whitelist.
 *
 * Default:
 *   FORWARD_HEADERS is not set
 *
 * Effective whitelist:
 *   cookie, authorization, accept-language
 *
 * Override example:
 *   FORWARD_HEADERS=cookie,authorization,accept-language,x-request-id
 *
 * Disable forwarding completely:
 *   FORWARD_HEADERS=
 *
 * Endpoint must also opt in:
 *   {
 *     "name": "userById",
 *     "forwardHeaders": true
 *   }
 */
function buildForwardHeaders(endpoint, incomingHeaders = {}) {
    const headers = {};

    if (endpoint.forwardHeaders === true) {
        const allowedHeaders = getAllowedForwardHeaders();

        for (const headerName of allowedHeaders) {
            const value = getHeaderCaseInsensitive(incomingHeaders, headerName);

            if (value === undefined) {
                continue;
            }

            headers[headerName] = Array.isArray(value)
                ? value.join(", ")
                : String(value);
        }
    }

    return {
        ...headers,
        "content-type": "application/json",
        ...(endpoint.headers ?? {})
    };
}

function getAllowedForwardHeaders() {
    const raw = process.env.FORWARD_HEADERS;

    if (raw === undefined) {
        return [
            "cookie",
            "authorization",
            "accept-language"
        ];
    }

    return raw
        .split(",")
        .map(header => header.trim().toLowerCase())
        .filter(Boolean)
        .filter(header => !isHopByHopHeader(header));
}

function getHeaderCaseInsensitive(headers, wantedName) {
    const wantedLowerName = wantedName.toLowerCase();

    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === wantedLowerName) {
            return value;
        }
    }

    return undefined;
}

function isHopByHopHeader(name) {
    return [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer"
    ].includes(name.toLowerCase());
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

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}/graphql`);
});