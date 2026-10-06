import type { FormattedScidRecord } from "../reader/scid-reader.js";

export interface InitMessage {
	readonly type: "INIT";
	readonly fileName: string;
	readonly summary: {
		readonly fileType: string;
		readonly headerSize: number;
		readonly recordSize: number;
		readonly version: number;
		readonly totalRecords: number;
		readonly fileSize: number;
		readonly firstRecordIsoUtc?: string | undefined;
		readonly lastRecordIsoUtc?: string | undefined;
	};
	readonly offsetIndex: number;
	readonly pageSize: number;
	readonly records: ReadonlyArray<FormattedScidRecord>;
}

export interface PageDataMessage {
	readonly type: "PAGE_DATA";
	readonly offsetIndex: number;
	readonly pageSize: number;
	readonly totalRecords: number;
	readonly records: ReadonlyArray<FormattedScidRecord>;
}

export interface AppendRecordsMessage {
	readonly type: "APPEND_RECORDS";
	readonly records: ReadonlyArray<FormattedScidRecord>;
	readonly totalRecords: number;
	readonly fileSize: number;
	readonly lastRecordIsoUtc?: string | undefined;
}

export interface ErrorMessage {
	readonly type: "ERROR";
	readonly message: string;
}

export type ExtensionToWebviewMessage =
	| InitMessage
	| PageDataMessage
	| AppendRecordsMessage
	| ErrorMessage;

export interface RequestPageMessage {
	readonly type: "REQUEST_PAGE";
	readonly offsetIndex: number;
	readonly pageSize: number;
}

export interface ToggleLiveTailMessage {
	readonly type: "TOGGLE_LIVE_TAIL";
	readonly enabled: boolean;
}

export type WebviewToExtensionMessage =
	| RequestPageMessage
	| ToggleLiveTailMessage;
