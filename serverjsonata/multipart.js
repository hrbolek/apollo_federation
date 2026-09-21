/**
 * Reads either:
 *
 * 1. application/json
 *      {
 *          "query": "...",
 *          "variables": {...},
 *          "operationName": "..."
 *      }
 *
 * 2. multipart/form-data following the GraphQL multipart request convention:
 *
 *      operations = {
 *          "query": "...",
 *          "variables": { "file": null }
 *      }
 *
 *      map = {
 *          "0": ["variables.file"]
 *      }
 *
 *      0 = <binary file>
 *
 * express.json() intentionally ignores multipart/form-data, therefore
 * the original request stream is still available here.
 */
export async function readGraphqlPayload(req) {
    const contentType =
        getHeaderCaseInsensitive(
            req.headers,
            "content-type"
        ) ?? "";

    if (
        contentType
            .toLowerCase()
            .startsWith("multipart/form-data")
    ) {
        return readGraphqlMultipartPayload(
            req,
            contentType
        );
    }

    return req.body ?? {};
}

export async function readGraphqlMultipartPayload(
    req,
    contentType
) {
    const maxBytes = parseByteLimit(
        process.env.MULTIPART_BODY_LIMIT ?? "50mb"
    );

    const body = await readRequestBody(
        req,
        maxBytes
    );

    /*
     * Node's WHATWG Request/FormData implementation can parse the
     * multipart body including its boundary. No multer dependency is needed.
     */
    const multipartRequest = new Request(
        "http://localhost/graphql",
        {
            method: "POST",
            headers: {
                "content-type": contentType
            },
            body
        }
    );

    const form = await multipartRequest.formData();

    const operationsRaw = form.get("operations");
    const mapRaw = form.get("map");

    if (
        typeof operationsRaw !== "string" ||
        !operationsRaw
    ) {
        throw new Error(
            "Multipart GraphQL request is missing the 'operations' field."
        );
    }

    let operations;

    try {
        operations = JSON.parse(operationsRaw);
    } catch (error) {
        throw new Error(
            `Invalid multipart 'operations' JSON: ${error.message}`
        );
    }

    /*
     * The GraphQL multipart request convention uses `map`.
     * For convenience, if there is no map and there are no files,
     * the request still behaves like a normal GraphQL request.
     */
    if (mapRaw === null) {
        const hasFile = Array.from(form.values())
            .some(value => isFileLike(value));

        if (hasFile) {
            throw new Error(
                "Multipart GraphQL request containing files is missing the 'map' field."
            );
        }

        return operations;
    }

    if (typeof mapRaw !== "string") {
        throw new Error(
            "Multipart GraphQL field 'map' must be a JSON string."
        );
    }

    let fileMap;

    try {
        fileMap = JSON.parse(mapRaw);
    } catch (error) {
        throw new Error(
            `Invalid multipart 'map' JSON: ${error.message}`
        );
    }

    if (
        fileMap === null ||
        typeof fileMap !== "object" ||
        Array.isArray(fileMap)
    ) {
        throw new Error(
            "Multipart GraphQL 'map' must be a JSON object."
        );
    }

    for (
        const [fileKey, targetPaths]
        of Object.entries(fileMap)
    ) {
        if (!Array.isArray(targetPaths)) {
            throw new Error(
                `Multipart map entry '${fileKey}' must contain an array of target paths.`
            );
        }

        const file = form.get(fileKey);

        if (!isFileLike(file)) {
            throw new Error(
                `Multipart file '${fileKey}' is missing.`
            );
        }

        for (const targetPath of targetPaths) {
            if (typeof targetPath !== "string") {
                throw new Error(
                    `Multipart map entry '${fileKey}' contains a non-string target path.`
                );
            }

            setObjectPath(
                operations,
                targetPath,
                file
            );
        }
    }

    return operations;
}

export function readRequestBody(req, maxBytes) {
    return new Promise(
        (resolve, reject) => {
            const chunks = [];
            let total = 0;
            let completed = false;

            const fail = error => {
                if (completed) {
                    return;
                }

                completed = true;
                reject(error);
            };

            req.on("data", chunk => {
                if (completed) {
                    return;
                }

                total += chunk.length;

                if (total > maxBytes) {
                    fail(
                        new Error(
                            `Multipart request body exceeds limit of ${maxBytes} bytes.`
                        )
                    );

                    req.destroy();
                    return;
                }

                chunks.push(chunk);
            });

            req.on("end", () => {
                if (completed) {
                    return;
                }

                completed = true;
                resolve(
                    Buffer.concat(chunks)
                );
            });

            req.on("error", fail);

            req.on("aborted", () => {
                fail(
                    new Error(
                        "Multipart request was aborted."
                    )
                );
            });
        }
    );
}

function parseByteLimit(value) {
    if (typeof value === "number") {
        return value;
    }

    const text = String(value)
        .trim()
        .toLowerCase();

    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(
        text
    );

    if (!match) {
        throw new Error(
            `Invalid byte limit '${value}'. Examples: 1048576, 10mb, 1gb.`
        );
    }

    const number = Number(match[1]);

    const multiplier = {
        b: 1,
        kb: 1024,
        mb: 1024 ** 2,
        gb: 1024 ** 3
    }[match[2] ?? "b"];

    return Math.floor(number * multiplier);
}

export function setObjectPath(
    target,
    path,
    value
) {
    const parts = path
        .split(".")
        .filter(Boolean);

    if (parts.length === 0) {
        throw new Error(
            "Multipart target path cannot be empty."
        );
    }

    let current = target;

    for (
        let index = 0;
        index < parts.length - 1;
        index += 1
    ) {
        const key = parts[index];

        if (
            current === null ||
            typeof current !== "object"
        ) {
            throw new Error(
                `Cannot assign multipart file to '${path}'.`
            );
        }

        if (!(key in current)) {
            throw new Error(
                `Multipart target path '${path}' does not exist in operations.`
            );
        }

        current = current[key];
    }

    const finalKey =
        parts[parts.length - 1];

    if (
        current === null ||
        typeof current !== "object"
    ) {
        throw new Error(
            `Cannot assign multipart file to '${path}'.`
        );
    }

    current[finalKey] = value;
}


/**
 * Multipart endpoint configuration:
 *
 * {
 *   "name": "signDocument",
 *   "url": "http://sign-service/api/sign",
 *   "method": "POST",
 *   "requestEncoding": "multipart",
 *   "multipart": {
 *     "fields": {
 *       "personId": "args.personId",
 *       "reason": "args.reason"
 *     },
 *     "files": {
 *       "file": "args.file"
 *     }
 *   }
 * }
 *
 * Each `fields` value and each `files` value is a path in:
 *
 * {
 *   args,
 *   variables
 * }
 *
 * Optional:
 *
 * "requestTransform": JSONata expression
 *
 * If present for multipart, the transform is evaluated without binary
 * File objects and can be included as one multipart field:
 *
 * "multipart": {
 *   "bodyField": "metadata",
 *   "bodyContentType": "application/json",
 *   "files": {
 *     "file": "args.file"
 *   }
 * }
 */
export async function buildMultipartBody(
    endpoint,
    args,
    variables
) {
    const multipart =
        endpoint.multipart ?? {};

    const form = new FormData();

    const jsonataContext = {
        args: stripFilesForJsonata(args),
        variables:
            stripFilesForJsonata(variables)
    };

    const context = {
        args,
        variables
    };

    /*
     * Simple scalar/object fields.
     */
    for (
        const [fieldName, source]
        of Object.entries(
            multipart.fields ?? {}
        )
    ) {
        const value =
            resolveMultipartSource(
                source,
                context
            );

        appendFormValue(
            form,
            fieldName,
            value
        );
    }

    /*
     * Optional transformed JSON metadata.
     */
    if (
        multipart.bodyField &&
        endpoint.requestTransform
    ) {
        const transformed =
            await evaluateJsonata(
                endpoint.requestTransform,
                jsonataContext
            );

        const bodyContentType =
            multipart.bodyContentType ??
            "application/json";

        if (
            bodyContentType ===
            "application/json"
        ) {
            form.append(
                multipart.bodyField,
                new Blob(
                    [
                        JSON.stringify(
                            transformed
                        )
                    ],
                    {
                        type:
                            "application/json"
                    }
                ),
                multipart.bodyFilename ??
                    "metadata.json"
            );
        } else {
            form.append(
                multipart.bodyField,
                String(transformed ?? "")
            );
        }
    }

    /*
     * Binary files.
     */
    for (
        const [fieldName, source]
        of Object.entries(
            multipart.files ?? {}
        )
    ) {
        const value =
            resolveMultipartSource(
                source,
                context
            );

        if (value === undefined ||
            value === null) {
            continue;
        }

        appendFileValue(
            form,
            fieldName,
            value
        );
    }

    return form;
}

export function resolveMultipartSource(
    source,
    context
) {
    if (
        typeof source !== "string"
    ) {
        return source;
    }

    return getObjectPath(
        context,
        source
    );
}

export function getObjectPath(
    target,
    path
) {
    const parts = path
        .split(".")
        .filter(Boolean);

    let current = target;

    for (const part of parts) {
        if (
            current === undefined ||
            current === null
        ) {
            return undefined;
        }

        current = current[part];
    }

    return current;
}

export function appendFormValue(
    form,
    fieldName,
    value
) {
    if (
        value === undefined ||
        value === null
    ) {
        return;
    }

    if (isFileLike(value)) {
        appendFileValue(
            form,
            fieldName,
            value
        );
        return;
    }

    if (
        typeof value === "string"
    ) {
        form.append(
            fieldName,
            value
        );
        return;
    }

    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        form.append(
            fieldName,
            String(value)
        );
        return;
    }

    form.append(
        fieldName,
        JSON.stringify(value)
    );
}

export function appendFileValue(
    form,
    fieldName,
    value
) {
    /*
     * Allow [File, File, ...] for upstream endpoints supporting
     * repeated multipart fields.
     */
    if (Array.isArray(value)) {
        for (const item of value) {
            appendFileValue(
                form,
                fieldName,
                item
            );
        }

        return;
    }

    if (!isFileLike(value)) {
        throw new Error(
            `Multipart field '${fieldName}' is configured as a file, but the value is not a File/Blob.`
        );
    }

    const filename =
        typeof value.name === "string" &&
        value.name
            ? value.name
            : "file";

    form.append(
        fieldName,
        value,
        filename
    );
}

export function isFileLike(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        typeof value.arrayBuffer === "function" &&
        typeof value.stream === "function" &&
        typeof value.type === "string"
    );
}

/**
 * Binary File/Blob objects should not be passed through JSONata.
 * They are replaced with small metadata objects.
 */
export function stripFilesForJsonata(value) {
    if (isFileLike(value)) {
        return {
            __file: true,
            name:
                typeof value.name === "string"
                    ? value.name
                    : undefined,
            type: value.type,
            size:
                typeof value.size === "number"
                    ? value.size
                    : undefined
        };
    }

    if (Array.isArray(value)) {
        return value.map(
            stripFilesForJsonata
        );
    }

    if (
        value !== null &&
        typeof value === "object"
    ) {
        return Object.fromEntries(
            Object.entries(value).map(
                ([key, item]) => [
                    key,
                    stripFilesForJsonata(item)
                ]
            )
        );
    }

    return value;
}