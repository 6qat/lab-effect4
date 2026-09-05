import {
	TcpStreamBunLive,
	TcpStreamEngineBunLive,
} from "./tcp-connection-bun.js";
import { defineTcpStreamTestSuite } from "./tcp-connection-test-suite.js";

defineTcpStreamTestSuite({
	engineName: "Bun",
	layerFactory: TcpStreamBunLive,
	basePort: 59120,
	engineLayer: TcpStreamEngineBunLive,
});
