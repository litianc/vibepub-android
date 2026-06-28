import { describe, expect, it } from "vitest";
import {
  buildVolcengineAuthorization,
  hashSha256,
  queryParamsToString,
} from "../src/volcengine_openapi.js";

describe("Volcengine OpenAPI signer", () => {
  it("canonicalizes query params in sorted order", () => {
    expect(queryParamsToString({
      Version: "2025-05-20",
      Action: "ServiceStatus",
      Empty: undefined,
      Multi: ["b", "a"],
    })).toBe("Action=ServiceStatus&Multi=a&Multi=b&Version=2025-05-20");
  });

  it("builds the expected authorization header for speech_saas_prod", () => {
    const body = JSON.stringify({
      ProjectName: "default",
      BlueprintID: 10029,
      ResourceID: "volc.service_type.10029",
    });
    const bodySha = hashSha256(body);
    const authorization = buildVolcengineAuthorization({
      accessKeyId: "AKLT_EXAMPLE",
      secretAccessKey: "SECRET_EXAMPLE",
      bodySha,
      headers: {
        Host: "open.volcengineapi.com",
        "X-Content-Sha256": bodySha,
        "X-Date": "20250818T135232Z",
        "Content-Type": "application/json; charset=UTF-8",
      },
      method: "POST",
      query: {
        Action: "ServiceStatus",
        Version: "2025-05-20",
      },
      region: "cn-beijing",
      serviceName: "speech_saas_prod",
    });

    expect(authorization).toBe(
      "HMAC-SHA256 Credential=AKLT_EXAMPLE/20250818/cn-beijing/speech_saas_prod/request, SignedHeaders=host;x-content-sha256;x-date, Signature=798f8eab19a4a81656abdcc366a4b211888ed28be73277a95a588ea9e6092aad",
    );
  });
});
