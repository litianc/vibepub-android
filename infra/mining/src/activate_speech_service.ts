import { callVolcengineOpenApi, VolcengineOpenApiError } from "./volcengine_openapi.js";

type ServiceStatusResult = {
  InstanceNumber?: string;
  ResourceID?: string;
  Level?: string;
  Status?: string;
  Clusters?: string[];
};

type SpeechServiceConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  projectName: string;
  blueprintId: number;
  resourceId: string;
};

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function requireEnv(label: string, ...names: string[]): string {
  const value = firstEnv(...names);
  if (!value) {
    throw new Error(`Missing ${label}. Set one of: ${names.join(", ")}`);
  }
  return value;
}

function getConfig(): SpeechServiceConfig {
  const blueprintIdValue = requireEnv("Volcengine speech BlueprintID", "VOLC_SPEECH_BLUEPRINT_ID");
  const blueprintId = Number.parseInt(blueprintIdValue, 10);
  if (!Number.isFinite(blueprintId)) {
    throw new Error(`VOLC_SPEECH_BLUEPRINT_ID must be an integer, got ${JSON.stringify(blueprintIdValue)}.`);
  }

  return {
    accessKeyId: requireEnv("Volcengine OpenAPI access key", "VOLCENGINE_ACCESS_KEY_ID", "VOLC_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("Volcengine OpenAPI secret key", "VOLCENGINE_SECRET_ACCESS_KEY", "VOLC_SECRET_ACCESS_KEY"),
    region: firstEnv("VOLCENGINE_REGION", "VOLC_REGION") || "cn-beijing",
    projectName: firstEnv("VOLCENGINE_PROJECT_NAME", "VOLC_PROJECT_NAME") || "default",
    blueprintId,
    resourceId: requireEnv("Volcengine speech ResourceID", "VOLC_SPEECH_RESOURCE_ID", "VOLC_ASR_RESOURCE_ID"),
  };
}

function speechOpenApiOptions(config: SpeechServiceConfig) {
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    serviceName: "speech_saas_prod",
    version: "2025-05-20",
  };
}

function servicePayload(config: SpeechServiceConfig) {
  return {
    ProjectName: config.projectName,
    BlueprintID: config.blueprintId,
    ResourceID: config.resourceId,
  };
}

async function getServiceStatus(config: SpeechServiceConfig): Promise<ServiceStatusResult | null> {
  try {
    const response = await callVolcengineOpenApi<ServiceStatusResult>(
      speechOpenApiOptions(config),
      "ServiceStatus",
      servicePayload(config),
    );
    return response.Result ?? null;
  } catch (error) {
    if (error instanceof VolcengineOpenApiError) {
      console.warn("ServiceStatus did not return active service state:", {
        code: error.code,
        requestId: error.requestId,
        message: error.message,
      });
      return null;
    }
    throw error;
  }
}

async function activateService(config: SpeechServiceConfig) {
  await callVolcengineOpenApi<Record<string, never>>(
    speechOpenApiOptions(config),
    "ActivateService",
    servicePayload(config),
  );
}

async function main() {
  const config = getConfig();
  console.log("Checking Volcengine speech service status:", {
    service: "speech_saas_prod",
    region: config.region,
    projectName: config.projectName,
    blueprintId: config.blueprintId,
    resourceId: config.resourceId,
  });

  const before = await getServiceStatus(config);
  if (before?.Status?.toLowerCase() === "active") {
    console.log("Volcengine speech service is already active:", {
      status: before.Status,
      resourceId: before.ResourceID,
      level: before.Level,
      clusters: before.Clusters,
    });
    return;
  }

  console.log("Activating Volcengine speech service...");
  await activateService(config);

  const after = await getServiceStatus(config);
  if (after?.Status?.toLowerCase() !== "active") {
    throw new Error(`ActivateService completed but ServiceStatus is not active: ${JSON.stringify(after)}`);
  }

  console.log("Volcengine speech service activated:", {
    status: after.Status,
    resourceId: after.ResourceID,
    level: after.Level,
    clusters: after.Clusters,
  });
}

main().catch(error => {
  if (error?.response?.data) {
    console.error("Volcengine speech service activation failed:", {
      message: error.message,
      httpStatus: error.response.status,
      responseData: error.response.data,
    });
  } else {
    console.error("Volcengine speech service activation failed:", {
      message: error?.message,
      code: error?.code,
      requestId: error?.requestId,
    });
  }
  process.exit(1);
});
