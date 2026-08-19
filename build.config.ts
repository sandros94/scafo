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
        "./src/agent/index",
        "./src/cli/index",
        "./src/drivers/store/uns3",
        "./src/drivers/store/memory",
        "./src/drivers/host/node",
        "./src/drivers/supervisor/child",
      ],
      rolldown: {
        platform: "neutral",
        external: ["uns3", "unjwt", /^unjwt\//, "h3", "confbox", "citty", /^node:/],
      },
    },
  ],
});
