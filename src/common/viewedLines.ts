/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import type { PRUriParams } from './uri';

/** Inclusive, zero-based line numbers. */
export type LineRange = [start: number, end: number];

export function getViewedLinesKey(uri: Pick<Uri, 'authority' | 'path'>, params: Pick<PRUriParams, 'remoteName' | 'prNumber' | 'headCommit' | 'fileName' | 'isBase' | 'baseCommit'>): string {
	return `viewedLines:${JSON.stringify([
		uri.authority, uri.path, params.remoteName, params.prNumber,
		params.headCommit, params.fileName, params.isBase, params.isBase ? params.baseCommit : undefined
	])}`;
}

/** Merge marked ranges, or remove selected lines (splitting existing ranges when needed). */
export function updateViewedLines(current: readonly LineRange[], selections: readonly LineRange[], viewed: boolean): LineRange[] {
	if (!viewed) {
		let ranges = [...current];
		for (const [start, end] of selections) {
			ranges = ranges.flatMap(([first, last]) => {
				if (end < first || start > last) {
					return [[first, last]];
				}
				const remaining: LineRange[] = [];
				if (first < start) {
					remaining.push([first, start - 1]);
				}
				if (last > end) {
					remaining.push([end + 1, last]);
				}
				return remaining;
			});
		}
		return ranges;
	}

	const merged: LineRange[] = [];
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
