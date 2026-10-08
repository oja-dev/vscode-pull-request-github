/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Inclusive, zero-based line numbers. */
export type ReviewedLineRange = [number, number];

export function reviewedLinesKey(pr: string, head: string, file: string, isBase: boolean, baseCommit?: string): string {
	return `reviewedLines:${JSON.stringify([pr, head, file, isBase, isBase ? baseCommit : undefined])}`;
}

/** Merge marked ranges, or remove selected lines (splitting existing ranges when needed). */
export function updateReviewedLines(current: readonly ReviewedLineRange[], selections: readonly ReviewedLineRange[], reviewed: boolean): ReviewedLineRange[] {
	if (!reviewed) {
		return selections.reduce<ReviewedLineRange[]>((ranges, [start, end]) => ranges.flatMap(([first, last]) => {
			if (end < first || start > last) {
				return [[first, last]];
			}
			const remaining: ReviewedLineRange[] = [];
			if (first < start) {
				remaining.push([first, start - 1]);
			}
			if (last > end) {
				remaining.push([end + 1, last]);
			}
			return remaining;
		}), [...current]);
	}

	const merged: ReviewedLineRange[] = [];
	for (const [start, end] of [...current, ...selections].sort((a, b) => a[0] - b[0])) {
		const previous = merged[merged.length - 1];
		if (previous && start <= previous[1] + 1) {
			previous[1] = Math.max(previous[1], end);
		} else {
			merged.push([start, end]);
		}
	}
	return merged;
}
