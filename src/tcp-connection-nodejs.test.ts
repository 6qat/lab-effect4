import {
	TcpStreamEngineNodejsLive,
	TcpStreamNodejsLive,
} from "./tcp-connection-nodejs.js";
import { defineTcpStreamTestSuite } from "./tcp-connection-test-suite.js";

defineTcpStreamTestSuite({
	engineName: "Node.js",
	layerFactory: TcpStreamNodejsLive,
	basePort: 59220,
	engineLayer: TcpStreamEngineNodejsLive,
});
