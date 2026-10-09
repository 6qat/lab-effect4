export const ROW_HEIGHT = 28;

export const MAX_CONTAINER_HEIGHT = 5_000_000;

export const OVERSCAN_ROWS = 15;

export const CHUNK_SIZE = 500;

export const MAX_CACHED_CHUNKS = 20;

export const PREFETCH_MARGIN = 250;

export const FOLLOW_THRESHOLD_PX = 50;

export interface VirtualScrollMetrics {
	readonly totalVirtualHeight: number;
	readonly isScaled: boolean;
	readonly scaleRatio: number;
}

export const calculateVirtualScrollMetrics = (
	totalRecords: number,
	rowHeight = ROW_HEIGHT,
	maxContainerHeight = MAX_CONTAINER_HEIGHT,
): VirtualScrollMetrics => {
	const rawHeight = totalRecords * rowHeight;
	if (rawHeight <= maxContainerHeight) {
		return {
			totalVirtualHeight: rawHeight,
			isScaled: false,
			scaleRatio: 1,
		};
	}
	return {
		totalVirtualHeight: maxContainerHeight,
		isScaled: true,
		scaleRatio: maxContainerHeight / rawHeight,
	};
};

export const calculateSpacerHeights = (
	startIndex: number,
	renderedCount: number,
	totalRecords: number,
	rowHeight = ROW_HEIGHT,
	maxContainerHeight = MAX_CONTAINER_HEIGHT,
): { topSpacerHeight: number; bottomSpacerHeight: number } => {
	const metrics = calculateVirtualScrollMetrics(
		totalRecords,
		rowHeight,
		maxContainerHeight,
	);
	if (!metrics.isScaled) {
		const topSpacerHeight = startIndex * rowHeight;
		const remaining = Math.max(0, totalRecords - (startIndex + renderedCount));
		const bottomSpacerHeight = remaining * rowHeight;
		return { topSpacerHeight, bottomSpacerHeight };
	}
	const topSpacerHeight = Math.round(
		startIndex * rowHeight * metrics.scaleRatio,
	);
	const remaining = Math.max(0, totalRecords - (startIndex + renderedCount));
	const bottomSpacerHeight = Math.max(
		0,
		Math.round(remaining * rowHeight * metrics.scaleRatio),
	);
	return { topSpacerHeight, bottomSpacerHeight };
};

export interface ChunkSliceResult<T> {
	readonly records: ReadonlyArray<T | undefined>;
	readonly missingChunkIndices: ReadonlyArray<number>;
}

export class LruChunkCache<T> {
	private readonly chunks = new Map<number, ReadonlyArray<T>>();

	constructor(
		public readonly maxChunks: number = MAX_CACHED_CHUNKS,
		public readonly chunkSize: number = CHUNK_SIZE,
	) {}

	get size(): number {
		return this.chunks.size;
	}

	has(chunkIndex: number): boolean {
		return this.chunks.has(chunkIndex);
	}

	get(chunkIndex: number): ReadonlyArray<T> | undefined {
		const chunk = this.chunks.get(chunkIndex);
		if (chunk === undefined) {
			return undefined;
		}
		// Refresh recency
		this.chunks.delete(chunkIndex);
		this.chunks.set(chunkIndex, chunk);
		return chunk;
	}

	put(chunkIndex: number, records: ReadonlyArray<T>): void {
		if (this.chunks.has(chunkIndex)) {
			this.chunks.delete(chunkIndex);
		} else if (this.chunks.size >= this.maxChunks) {
			const oldestKey = this.chunks.keys().next().value;
			if (oldestKey !== undefined) {
				this.chunks.delete(oldestKey);
			}
		}
		this.chunks.set(chunkIndex, records);
	}

	putRecords(records: ReadonlyArray<T & { index: number }>): void {
		for (let i = 0; i < records.length; i++) {
			const rec = records[i];
			if (!rec) continue;
			const cIdx = Math.floor(rec.index / this.chunkSize);
			let chunk = this.chunks.get(cIdx) as (T | undefined)[] | undefined;
			if (!chunk) {
				if (this.chunks.size >= this.maxChunks) {
					const oldestKey = this.chunks.keys().next().value;
					if (oldestKey !== undefined) {
						this.chunks.delete(oldestKey);
					}
				}
				chunk = new Array(this.chunkSize);
				this.chunks.set(cIdx, chunk as ReadonlyArray<T>);
			}
			const offsetInChunk = rec.index - cIdx * this.chunkSize;
			chunk[offsetInChunk] = rec;
		}
	}

	isComplete(chunkIndex: number, totalRecords: number): boolean {
		const chunk = this.chunks.get(chunkIndex);
		if (!chunk) return false;
		const startIdx = chunkIndex * this.chunkSize;
		if (startIdx >= totalRecords) return true;
		const endIdx = Math.min(totalRecords, startIdx + this.chunkSize);
		for (let idx = startIdx; idx < endIdx; idx++) {
			const offset = idx - startIdx;
			if (chunk[offset] === undefined) return false;
		}
		return true;
	}

	getRecord(recordIndex: number): T | undefined {
		const chunkIndex = Math.floor(recordIndex / this.chunkSize);
		const chunk = this.get(chunkIndex);
		if (!chunk) return undefined;
		const offsetInChunk = recordIndex - chunkIndex * this.chunkSize;
		return chunk[offsetInChunk];
	}

	getSlice(startIndex: number, count: number): ChunkSliceResult<T> {
		const records: (T | undefined)[] = [];
		const missingChunks = new Set<number>();

		for (let i = 0; i < count; i++) {
			const recIdx = startIndex + i;
			const chunkIdx = Math.floor(recIdx / this.chunkSize);
			const chunk = this.get(chunkIdx);
			if (!chunk) {
				missingChunks.add(chunkIdx);
				records.push(undefined);
			} else {
				const offsetInChunk = recIdx - chunkIdx * this.chunkSize;
				const rec = chunk[offsetInChunk];
				if (rec === undefined) {
					missingChunks.add(chunkIdx);
				}
				records.push(rec);
			}
		}

		return {
			records,
			missingChunkIndices: Array.from(missingChunks),
		};
	}

	getCachedChunkIndices(): number[] {
		return Array.from(this.chunks.keys());
	}

	clear(): void {
		this.chunks.clear();
	}
}

export const calculatePrefetchChunkIndices = (
	startIndex: number,
	count: number,
	totalRecords: number,
	chunkSize = CHUNK_SIZE,
	prefetchMargin = PREFETCH_MARGIN,
): { visibleChunkIndices: number[]; prefetchChunkIndices: number[] } => {
	if (totalRecords <= 0 || count <= 0) {
		return { visibleChunkIndices: [], prefetchChunkIndices: [] };
	}

	const maxIndex = totalRecords - 1;
	const clampedStart = Math.max(0, Math.min(maxIndex, startIndex));
	const clampedEnd = Math.max(0, Math.min(maxIndex, startIndex + count - 1));

	const startChunk = Math.floor(clampedStart / chunkSize);
	const endChunk = Math.floor(clampedEnd / chunkSize);

	const visibleChunkIndices: number[] = [];
	for (let c = startChunk; c <= endChunk; c++) {
		visibleChunkIndices.push(c);
	}

	const prefetchChunkIndices: number[] = [];
	if (clampedStart > 0) {
		const backwardIndex = Math.max(0, clampedStart - prefetchMargin);
		const backwardChunk = Math.floor(backwardIndex / chunkSize);
		if (backwardChunk < startChunk) {
			prefetchChunkIndices.push(backwardChunk);
		}
	}

	if (clampedEnd < maxIndex) {
		const forwardIndex = Math.min(maxIndex, clampedEnd + prefetchMargin);
		const forwardChunk = Math.floor(forwardIndex / chunkSize);
		if (forwardChunk > endChunk) {
			prefetchChunkIndices.push(forwardChunk);
		}
	}

	return { visibleChunkIndices, prefetchChunkIndices };
};

export const isScrolledToBottom = (
	scrollTop: number,
	viewportHeight: number,
	totalVirtualHeight: number,
	thresholdPx = FOLLOW_THRESHOLD_PX,
): boolean => {
	const maxScroll = Math.max(0, totalVirtualHeight - viewportHeight);
	return maxScroll - scrollTop <= thresholdPx;
};

export interface FollowScrollState {
	readonly liveTail: boolean;
	readonly isFollowing: boolean;
	readonly unreadCount: number;
}

export const handleFollowScroll = (
	currentState: FollowScrollState,
	scrollTop: number,
	viewportHeight: number,
	totalVirtualHeight: number,
	thresholdPx = FOLLOW_THRESHOLD_PX,
): FollowScrollState => {
	if (!currentState.liveTail) {
		return currentState;
	}

	const atBottom = isScrolledToBottom(
		scrollTop,
		viewportHeight,
		totalVirtualHeight,
		thresholdPx,
	);

	if (atBottom) {
		return {
			liveTail: true,
			isFollowing: true,
			unreadCount: 0,
		};
	}

	return {
		liveTail: true,
		isFollowing: false,
		unreadCount: currentState.unreadCount,
	};
};

export interface AppendFollowResult {
	readonly nextState: FollowScrollState;
	readonly shouldSnapToBottom: boolean;
}

export const resumeFollow = (
	_currentState: FollowScrollState,
): FollowScrollState => ({
	liveTail: true,
	isFollowing: true,
	unreadCount: 0,
});

export const formatUnreadPillText = (unreadCount: number): string =>
	`↓ ${unreadCount.toLocaleString()} new trades — Resume Live Tail`;
