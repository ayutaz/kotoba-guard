import { installOffscreenRuntime } from "../extension/src/offscreen/runtime";

installOffscreenRuntime({ retainWorkerMs: 60000 });
