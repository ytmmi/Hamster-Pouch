/** 注册开发期自检所用的 ESM 解析钩子（见 tools/blueprint-check-loader.mjs）。 */
import { register } from "node:module";

register(new URL("blueprint-check-loader.mjs", import.meta.url));
