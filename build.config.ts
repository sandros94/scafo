import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index",
        "./src/core/registry/index",
        "./src/core/auth/index",
        "./src/core/placement/index",
        "./src/daemon/index",
        "./src/cli/index",
        "./src/drivers/store/uns3",
        "./src/drivers/store/memory",
        "./src/drivers/runtime/celld",
        "./src/drivers/supervisor/child",
        "./src/drivers/ingress/traefik",
        "./src/drivers/deploy/celld",
        "./src/drivers/archive/tar-zst",
        "./src/drivers/observe/access-log",
      ],
      rolldown: {
        platform: "neutral",
        external: [
          "uns3",
          "unjwt",
          /^unjwt\//,
          "unsecure",
          /^unsecure\//,
          "h3",
          "confbox",
          // "citty"  is NOT external as it is currently being patched
          "consola",
          "tar",
          /^node:/,
        ],
      },
    },
  ],
});
