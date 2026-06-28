import axios from "axios";
import crypto from "crypto";

const OPENAPI_HOST = "open.volcengineapi.com";
const OPENAPI_ENDPOINT = `https://${OPENAPI_HOST}`;

const HEADER_KEYS_TO_IGNORE = new Set([
  "authorization",
  "content-type",
  "content-length",
  "user-agent",
  "presigned-expires",
  "expect",
]);

type SignParams = {
  accessKeyId: string;
  secretAccessKey: string;
  bodySha: string;
  headers: Record<string, string>;
  method: string;
  pathName?: string;
  query: Record<string, string | number | Array<string | number> | undefined>;
  region: string;
  serviceName: string;
};

export type VolcengineOpenApiOptions = {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  serviceName: string;
  version: string;
};

export type VolcengineOpenApiResponse<T> = {
  ResponseMetadata?: {
    RequestId?: string;
    RequestID?: string;
    Action?: string;
    Version?: string;
    Service?: string;
    Region?: string;
    Error?: {
      Code?: string;
      Message?: string;
    };
  };
  Result?: T;
};

export class VolcengineOpenApiError extends Error {
  readonly code?: string;
  readonly requestId?: string;
  readonly responseData: unknown;

  constructor(message: string, responseData: unknown, code?: string, requestId?: string) {
    super(message);
    this.name = "VolcengineOpenApiError";
    this.code = code;
    this.requestId = requestId;
    this.responseData = responseData;
  }
}

export function hashSha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(secret: string | Buffer, value: string): Buffer {
  return crypto.createHmac("sha256", secret).update(value, "utf8").digest();
}

function uriEscape(value: string | number): string {
  return encodeURIComponent(String(value))
    .replace(/[^A-Za-z0-9_.~\-%]+/g, escape)
    .replace(/\*/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function queryParamsToString(params: SignParams["query"]): string {
  return Object.keys(params)
    .sort()
    .map(key => {
      const value = params[key];
      if (value === undefined || value === null) {
        return undefined;
      }

      const escapedKey = uriEscape(key);
      if (Array.isArray(value)) {
        return `${escapedKey}=${value.map(uriEscape).sort().join(`&${escapedKey}=`)}`;
      }

      return `${escapedKey}=${uriEscape(value)}`;
    })
    .filter((value): value is string => Boolean(value))
    .join("&");
}

function getSignHeaders(originHeaders: Record<string, string>, needSignHeaderKeys: string[]) {
  const needSignSet = new Set([...needSignHeaderKeys, "x-date", "host"].map(key => key.toLowerCase()));
  const headerKeys = Object.keys(originHeaders)
    .filter(key => needSignSet.has(key.toLowerCase()))
    .filter(key => !HEADER_KEYS_TO_IGNORE.has(key.toLowerCase()));

  const signedHeaders = headerKeys
    .map(key => key.toLowerCase())
    .sort()
    .join(";");

  const canonicalHeaders = headerKeys
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map(key => `${key.toLowerCase()}:${originHeaders[key].trim().replace(/\s+/g, " ")}`)
    .join("\n");

  return { signedHeaders, canonicalHeaders };
}

export function buildVolcengineAuthorization(params: SignParams): string {
  const pathName = params.pathName ?? "/";
  const datetime = params.headers["X-Date"] ?? params.headers["x-date"];
  if (!datetime) {
    throw new Error("X-Date header is required for Volcengine OpenAPI signing.");
  }

  const date = datetime.substring(0, 8);
  const { signedHeaders, canonicalHeaders } = getSignHeaders(params.headers, [
    "host",
    "x-date",
    "x-content-sha256",
  ]);
  const canonicalRequest = [
    params.method.toUpperCase(),
    pathName,
    queryParamsToString(params.query),
    `${canonicalHeaders}\n`,
    signedHeaders,
    params.bodySha,
  ].join("\n");
  const credentialScope = [date, params.region, params.serviceName, "request"].join("/");
  const stringToSign = [
    "HMAC-SHA256",
    datetime,
    credentialScope,
    hashSha256(canonicalRequest),
  ].join("\n");
  const kDate = hmac(params.secretAccessKey, date);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, params.serviceName);
  const kSigning = hmac(kService, "request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return [
    "HMAC-SHA256",
    `Credential=${params.accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(" ");
}

function getDateTimeNow(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export async function callVolcengineOpenApi<T>(
  options: VolcengineOpenApiOptions,
  action: string,
  payload: Record<string, unknown>,
): Promise<VolcengineOpenApiResponse<T>> {
  const method = "POST";
  const region = options.region || "cn-beijing";
  const query = {
    Action: action,
    Version: options.version,
  };
  const body = JSON.stringify(payload);
  const bodySha = hashSha256(body);
  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    Host: OPENAPI_HOST,
    "X-Content-Sha256": bodySha,
    "X-Date": getDateTimeNow(),
  };
  const authorization = buildVolcengineAuthorization({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    bodySha,
    headers,
    method,
    query,
    region,
    serviceName: options.serviceName,
  });
  const response = await axios.post<VolcengineOpenApiResponse<T>>(
    `${OPENAPI_ENDPOINT}/?${queryParamsToString(query)}`,
    body,
    {
      headers: {
        ...headers,
        Authorization: authorization,
      },
      timeout: 30_000,
      transformRequest: data => data,
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    const requestId = response.data?.ResponseMetadata?.RequestId ?? response.data?.ResponseMetadata?.RequestID;
    const error = response.data?.ResponseMetadata?.Error;
    throw new VolcengineOpenApiError(
      `Volcengine ${options.serviceName}.${action} HTTP ${response.status}: ${error?.Code ?? "Unknown"} ${error?.Message ?? ""}`.trim(),
      response.data,
      error?.Code,
      requestId,
    );
  }

  const error = response.data.ResponseMetadata?.Error;
  if (error) {
    const requestId = response.data.ResponseMetadata?.RequestId ?? response.data.ResponseMetadata?.RequestID;
    throw new VolcengineOpenApiError(
      `Volcengine ${options.serviceName}.${action} failed: ${error.Code ?? "Unknown"} ${error.Message ?? ""}`.trim(),
      response.data,
      error.Code,
      requestId,
    );
  }

  return response.data;
}
