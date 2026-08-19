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
        "./src/drivers/store/uns3",
        "./src/drivers/store/memory",
        "./src/drivers/host/node",
      ],
      rolldown: {
        platform: "neutral",
        external: ["uns3", "unjwt", /^unjwt\//, /^node:/],
      },
    },
  ],
});
