import { execNative, type NativeRequest } from "./native.ts";

// The native RegExp runs in this worker, not on the page's main thread, and every comparison has a timeout (see
// native-comparison.ts). V8 backtracks exponentially on patterns such as (a|a)+b against "a…a", so a run can take
// effectively forever; a blocked main thread would freeze the whole playground.
addEventListener("message", (event: MessageEvent<NativeRequest>) => {
  postMessage(execNative(event.data.pattern, event.data.input));
});
