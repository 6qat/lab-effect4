import {
	TcpStreamEnginePlatformLive,
	TcpStreamPlatformLive,
} from "./tcp-connection-platform.js";
import { defineTcpStreamTestSuite } from "./tcp-connection-test-suite.js";

defineTcpStreamTestSuite({
	engineName: "Platform",
	layerFactory: TcpStreamPlatformLive,
	basePort: 59320,
	engineLayer: TcpStreamEnginePlatformLive,
});
