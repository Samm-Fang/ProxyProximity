import type { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";

function getApiKey(event: HandlerEvent): string | null {
  const authHeader = event.headers["authorization"];
  const apiKeyFromAuth = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

  return event.queryStringParameters?.["key"] ||
    apiKeyFromAuth ||
    event.headers["x-api-key"] ||
    event.headers["x-goog-api-key"] ||
    process.env.UNIVERSAL_API_KEY ||
    null;
}

const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const { httpMethod, body } = event;

  // Handle OPTIONS for CORS preflight
  if (httpMethod === "OPTIONS") {
    const optionsHeaders: Record<string, string | number | boolean> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, x-api-key, x-goog-api-key, Content-Type",
      "Access-Control-Max-Age": 86400,
    };
    return {
      statusCode: 204,
      headers: optionsHeaders,
      body: ''
    };
  }

  try {
    const apiKey = getApiKey(event);
    if (!apiKey) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          error: "API key required via Authorization header, x-api-key header or key query parameter"
        }),
      };
    }

    // Extract the target path from the 'path' query parameter, which is populated by the rewrite rule.
    const targetPath = event.queryStringParameters?.['path'];
    if (!targetPath) {
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
                error: "Target path not provided. The URL should be /api/[target-path]"
            }),
        };
    }

    const pathSegments = targetPath.split('/').filter(segment => segment.length > 0);
    let targetDomain = pathSegments[0];
    targetDomain = targetDomain.replace(/^https?:\/\//, '');
    const remainingPath = pathSegments.slice(1).join('/');
    
    const targetBaseUrl = `https://${targetDomain}`;

    // Reconstruct the query string, excluding the 'path' parameter used for routing.
    const params = new URLSearchParams();
    if (event.queryStringParameters) {
        for (const [key, value] of Object.entries(event.queryStringParameters)) {
            if (key !== 'path' && value) {
                params.set(key, value);
            }
        }
    }
    const queryString = params.toString();
    const targetUrl = new URL(`${targetBaseUrl}/${remainingPath}${queryString ? '?' + queryString : ''}`);

    // Prepare headers for forwarding, removing client-specific auth headers.
    const forwardHeaders = new Headers();
    for (const [key, value] of Object.entries(event.headers)) {
      if (typeof value === 'string' && ![
        'host',
        'authorization',
        'x-api-key',
        'x-goog-api-key'
      ].includes(key.toLowerCase())) {
        forwardHeaders.set(key, value);
      }
    }

    // Add the correct API key header based on the target domain.
    const isGoogleStyle = targetDomain.includes('generativelanguage.googleapis.com');
    if (isGoogleStyle) {
      forwardHeaders.set('X-Goog-Api-Key', apiKey);
    } else {
      forwardHeaders.set('Authorization', `Bearer ${apiKey}`);
    }

    // Forward the request to the target API.
    const apiResponse = await fetch(targetUrl.toString(), {
      method: httpMethod,
      headers: forwardHeaders,
      body: body,
    });

    // Prepare response headers for the client.
    const responseHeaders = new Headers();
    apiResponse.headers.forEach((value, key) => {
        // Let the browser handle content encoding.
        if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
            responseHeaders.set(key, value);
        }
    });
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // For binary data, we need to get the ArrayBuffer and encode it to base64.
    const contentType = apiResponse.headers.get('Content-Type');
    let responseBody: string;
    let isBase64Encoded = false;

    if (contentType?.includes('application/json') || contentType?.includes('text/')) {
        responseBody = await apiResponse.text();
    } else {
        // Handle binary responses by encoding them in Base64.
        const buffer = await apiResponse.arrayBuffer();
        responseBody = Buffer.from(buffer).toString('base64');
        isBase64Encoded = true;
    }

    return {
      statusCode: apiResponse.status,
      headers: Object.fromEntries(responseHeaders.entries()),
      body: responseBody,
      isBase64Encoded: isBase64Encoded,
    };

  } catch (error) {
    console.error("Proxy error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "Internal Server Error",
        details: error instanceof Error ? error.message : String(error)
      }),
    };
  }
};

export { handler };