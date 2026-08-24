import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: [
        "./src/index",
        "./src/core/registry/index",
        "./src/core/auth/index",
        "./src/core/capacity/index",
        "./src/core/placement/index",
        "./src/daemon/index",
        "./src/cli/index",
        "./src/drivers/store/uns3",
        "./src/drivers/store/memory",
        "./src/drivers/host/node",
        "./src/drivers/runtime/celld",
        "./src/drivers/supervisor/child",
        "./src/drivers/ingress/caddy",
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
          "h3",
          "confbox",
          "citty",
          "consola",
          "tar",
          /^node:/,
        ],
      },
    },
  ],
});
