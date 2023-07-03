import { parse } from "https://deno.land/std@0.192.0/flags/mod.ts";
import { parseAll } from "https://deno.land/std@0.192.0/yaml/mod.ts";

const parsedArgs = parse(Deno.args);

let k8sConfig = "";
if (parsedArgs.__file) {
  k8sConfig = await Deno.readTextFile(parsedArgs.__file);
} else {
  const decoder = new TextDecoder();
  for await (const chunk of Deno.stdin.readable) {
    k8sConfig += decoder.decode(chunk);
  }
}

const k8sYAML: any = parseAll(k8sConfig);

for (const resource of k8sYAML) {
  if (resource.kind == "HorizontalPodAutoscaler") {
    if (!doesScaleTargetExist(resource.spec.scaleTargetRef, k8sYAML)) {
      console.error(
        `${resource.kind}: ${resource.metadata.name} scaltetargeref does not exist: scaleTargetRef:\n`,
        resource.spec.scaleTargetRef,
      );
    }
  }

  if (resource.kind == "Service") {
    if (!doesServiceSelectorExist(resource.spec.selector, k8sYAML)) {
      console.log(
        `${resource.kind}: ${resource.metadata.name} selector does not exist. selector:\n`,
        resource.spec.selector,
      );
    }
  }

  // For now we only support `matchLabels`
  if (resource.kind == "PodMonitor") {
    if (!doesPodMonitorSelectorExist(resource.spec.selector, k8sYAML)) {
      console.error(
        `${resource.kind}: ${resource.metadata.name} selector does not exist. selector:\n`,
        resource.spec.selector,
      );
    }
  }

  // For now only support rules[].http.paths[].backend.service
  if (resource.kind == "Ingress") {
    for (const rule of resource!.spec!.rules) {
      for (const path of rule!.http!.paths) {
        if (!doesIngressBackendExist(path.backend, k8sYAML)) {
          console.log(
            `${resource.kind}: ${resource.metadata.name}, ${rule.host}, ${path.path} backend does not exist. backend:\n`,
            path.backend,
          );
        }
      }
    }
  }

  if (resource.kind == "Deployment" || resource.kind == "StatefulSet") {
    // Does not support .spec.selector.matchExpressions
    if (
      !labelsMatch(
        resource.spec.selector.matchLabels,
        resource.spec.template.metadata.labels,
      )
    ) {
      console.error(
        `${resource.kind}: ${resource.metadata.name} Deployment spec.selector does not match spec.template.metadata.lables: selector:\n`,
        resource.spec.selector.matchLabels,
        "spec.template.metadata.labels:\n",
        resource.spec.template.metadata.labels,
      );
    }

    const containers = [
      ...resource.spec.template.spec.containers,
      ...resource.spec.template.spec.initContainers
        ? resource.spec.template.spec.initContainers
        : [],
    ];
    for (const container of containers) {
      if (container.envFrom) {
        for (const envFrom of container.envFrom) {
          if (
            envFrom.configMapRef && !envFrom.configMapRef.optional &&
            !findResource(
              "ConfigMap",
              envFrom.configMapRef.name,
              k8sYAML,
            )
          ) {
            {
              console.error(
                `${resource.kind}: ${resource.metadata.name}, container ${container.name} (${container.image}) references configmap that does not exist. envFrom[].configMapRef:\n`,
                envFrom.configMapRef,
              );
            }
          }
          if (
            envFrom.secretRef && !envFrom.secretRef.optional &&
            !findResource("Secret", envFrom.secretRef.name, k8sYAML)
          ) {
            console.error(
              `${resource.kind}: ${resource.metadata.name}, container ${container.name} (${container.image}) references secret that does not exist. envFrom[].secretRef:\n`,
              envFrom.secretRef,
            );
          }
        }
      }

      // We don't support fieldRef for spec.template.spec.containers[].env[].valueFrom
      if (container.env) {
        for (const env of container.env) {
          if (
            env.valueFrom?.configMapKeyRef &&
            !env.valueFrom.configMapKeyRef.optional
          ) {
            const configMap = findResource(
              "ConfigMap",
              env.valueFrom.configMapKeyRef.name,
              k8sYAML,
            );
            if (!configMap) {
              console.error(
                `${resource.kind}: ${resource.metadata.name}, container ${container.name}, ${env.name} references configmap that does not exist. env[].valueFrom.configMapKeyRef:\n`,
                env.valueFrom.configMapKeyRef,
              );
              continue;
            }

            if (
              !Object.keys(configMap.data).some((d) =>
                d == env.valueFrom.configMapKeyRef.key
              )
            ) {
              console.error(
                `${resource.kind}: ${resource.metadata.name}, container ${container.name}, ${env.name} references key in configmap that does not exist. env[].valueFrom.configMapKeyRef:\n`,
                env.valueFrom.configMapKeyRef,
              );
            }
          }

          if (
            env.valueFrom?.secretKeyRef &&
            !env.valueFrom.secretKeyRef.optional
          ) {
            if (
              isSecretInSopsTemplate(
                env.valueFrom.secretKeyRef.name,
                env.valueFrom.secretKeyRef.key,
                k8sYAML,
              )
            ) {
              continue;
            }

            const secret = findResource(
              "Secret",
              env.valueFrom.secretKeyRef.name,
              k8sYAML,
            );

            if (!secret) {
              console.error(
                `${resource.kind}: ${resource.metadata.name}, container ${container.name}, ${env.name} references secret that does not exist. env[].valueFrom.secretKeyRef:\n`,
                env.valueFrom.secretKeyRef,
              );
              continue;
            }

            if (
              !Object.keys(secret.data).some((d) =>
                d == env.valueFrom.secretKeyRef.key
              )
            ) {
              console.error(
                `${resource.kind}: ${resource.metadata.name}, secret ${container.name}, ${env.name} references key in configmap that does not exist. env[].valueFrom.secretKeyRef:\n`,
                env.valueFrom.secretKeyRef,
              );
            }
          }
        }
      }
    }
  }
}

function isSecretInSopsTemplate(
  name: string,
  key: string,
  resources: any,
): boolean {
  for (const resource of resources) {
    if (resource.kind === "SopsSecret") {
      for (const secret of resource.spec.secretTemplates) {
        if (
          secret.name == name &&
          (
            (secret.stringData &&
              Object.keys(secret.stringData).some((k) => k == key)) ||
            (secret.data && Object.keys(secret.data).some((k) => k == key))
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function findResource(
  kind: string,
  name: string,
  resources: any,
): any | boolean {
  for (const resource of resources) {
    if (
      resource.kind == kind, resource.metadata.name == name
    ) {
      return resource;
    }
  }
  return false;
}

function doesScaleTargetExist(
  scaleTargetRef: { kind: string; apiVersion: string; name: string },
  resources: any,
): boolean {
  for (const resource of resources) {
    if (
      resource?.kind == scaleTargetRef.kind &&
      resource?.apiVersion == scaleTargetRef.apiVersion &&
      resource?.metadata?.name == scaleTargetRef.name
    ) {
      return true;
    }
  }
  return false;
}

function doesServiceSelectorExist(
  selector: { [key: string]: string },
  resources: any,
): boolean {
  for (const resource of resources) {
    if (resource?.spec?.template?.metadata?.labels) {
      if (labelsMatch(selector, resource?.spec?.template?.metadata?.labels)) {
        return true;
      }
    }
  }
  return false;
}

function doesPodMonitorSelectorExist(
  selector: { matchLabels: { [key: string]: string } },
  resources: any,
): boolean {
  for (const resource of resources) {
    if (resource?.spec?.template?.metadata?.labels) {
      if (
        labelsMatch(
          selector.matchLabels,
          resource?.spec?.template?.metadata?.labels,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

// This only supports finding service backends
function doesIngressBackendExist(
  backend: { service: { name: string; port: { name: string } } },
  resources: any,
): boolean {
  /*
    For mock services, for example we have a alb ingress that uses actions (https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.2/guide/ingress/annotations/#actions).
  */
  if (backend.service.port.name == "use-annotation") {
    return true;
  }

  for (const resource of resources) {
    if (
      resource.kind == "Service" &&
      resource.metadata.name == backend.service.name &&
      resource.spec.ports.some((p: { name: string }) =>
        p.name == backend.service.port.name
      )
    ) {
      return true;
    }
  }
  return false;
}

function labelsMatch(
  labelSelector: { [key: string]: string },
  labelSelectorTarget: { [key: string]: string },
): boolean {
  return Object.keys(labelSelector).reduce((acc, key) => {
    if (labelSelector[key] != labelSelectorTarget[key]) {
      return false;
    }
    return acc;
  }, true);
}
