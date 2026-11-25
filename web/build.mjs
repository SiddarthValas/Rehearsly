import { build } from "vite";
import config from "./vite.config.mjs";

// Use the shared config directly so builds do not need to bundle a TypeScript config first.
await build({ ...config, configFile: false });
