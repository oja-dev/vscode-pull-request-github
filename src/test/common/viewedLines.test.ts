/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { LineRange, getViewedLinesKey, updateViewedLines } from '../../common/viewedLines';

describe('Viewed line ranges', function () {
	it('marks the first line when no progress is saved', function () {
		assert.deepStrictEqual(updateViewedLines([], [[0, 0]], true), [[0, 0]]);
	});

	it('merges adjacent ranges on both sides', function () {
		assert.deepStrictEqual(updateViewedLines([[2, 4], [7, 9]], [[5, 6]], true), [[2, 9]]);
	});

	it('merges overlapping and contained ranges without shrinking them', function () {
		assert.deepStrictEqual(updateViewedLines([[2, 8]], [[6, 10], [3, 4], [2, 5]], true), [[2, 10]]);
	});

	it('sorts disjoint ranges and preserves unviewed gaps', function () {
		assert.deepStrictEqual(updateViewedLines([[10, 12]], [[20, 20], [0, 2], [5, 7]], true), [[0, 2], [5, 7], [10, 12], [20, 20]]);
	});

	it('merges a selection that bridges several existing ranges', function () {
		assert.deepStrictEqual(updateViewedLines([[0, 2], [5, 7], [10, 12]], [[2, 10]], true), [[0, 12]]);
	});

	it('is idempotent when marking the same range repeatedly', function () {
		const marked = updateViewedLines([[0, 2]], [[5, 7], [5, 7]], true);
		assert.deepStrictEqual(marked, [[0, 2], [5, 7]]);
		assert.deepStrictEqual(updateViewedLines(marked, [[5, 7]], true), marked);
	});

	it('splits an existing range when its middle is unmarked', function () {
		assert.deepStrictEqual(updateViewedLines([[0, 9]], [[3, 6]], false), [[0, 2], [7, 9]]);
	});

	it('splits a range around a single unmarked line', function () {
		assert.deepStrictEqual(updateViewedLines([[0, 4]], [[2, 2]], false), [[0, 1], [3, 4]]);
	});

	it('trims the beginning of a viewed range', function () {
		assert.deepStrictEqual(updateViewedLines([[2, 9]], [[0, 4]], false), [[5, 9]]);
	});

	it('trims the end of a viewed range', function () {
		assert.deepStrictEqual(updateViewedLines([[2, 9]], [[7, 12]], false), [[2, 6]]);
	});

	it('removes a fully covered range, including a single line', function () {
		assert.deepStrictEqual(updateViewedLines([[2, 9]], [[2, 9]], false), []);
		assert.deepStrictEqual(updateViewedLines([[2, 9]], [[0, 12]], false), []);
		assert.deepStrictEqual(updateViewedLines([[0, 0]], [[0, 0]], false), []);
	});

	it('removes a selection spanning multiple viewed ranges', function () {
		assert.deepStrictEqual(updateViewedLines([[0, 2], [5, 7], [10, 12]], [[1, 11]], false), [[0, 0], [12, 12]]);
	});

	it('leaves viewed ranges unchanged when unmarked lines are absent', function () {
		assert.deepStrictEqual(updateViewedLines([[2, 4], [8, 10]], [[0, 1], [5, 7], [11, 12]], false), [[2, 4], [8, 10]]);
		assert.deepStrictEqual(updateViewedLines([], [[0, 10]], false), []);
	});

	it('applies multiple removals and tolerates repeated removals', function () {
		assert.deepStrictEqual(updateViewedLines([[0, 10]], [[7, 8], [2, 3], [2, 3]], false), [[0, 1], [4, 6], [9, 10]]);
	});

	it('preserves ranges when there are no selections', function () {
		assert.deepStrictEqual(updateViewedLines([[0, 2], [5, 7]], [], true), [[0, 2], [5, 7]]);
		assert.deepStrictEqual(updateViewedLines([[0, 2], [5, 7]], [], false), [[0, 2], [5, 7]]);
	});

	for (const viewed of [true, false]) {
		it(`does not mutate input arrays or tuples when ${viewed ? 'marking' : 'unmarking'} lines`, function () {
			const current: LineRange[] = [[8, 10], [0, 5]];
			const selections: LineRange[] = [[4, 9], [2, 3]];
			current.forEach(range => Object.freeze(range));
			selections.forEach(range => Object.freeze(range));
			Object.freeze(current);
			Object.freeze(selections);

			const result = updateViewedLines(current, selections, viewed);

			assert.deepStrictEqual(current, [[8, 10], [0, 5]]);
			assert.deepStrictEqual(selections, [[4, 9], [2, 3]]);
			assert.notStrictEqual(result, current);
			assert.deepStrictEqual(result, viewed ? [[0, 10]] : [[10, 10], [0, 1]]);
		});
	}
});

describe('Viewed line storage keys', function () {
	const uri = { authority: 'host', path: '/workspace/repo/src/example.ts' };
	const params = { remoteName: 'origin', prNumber: 1, headCommit: 'head-sha', fileName: 'src/example.ts', isBase: false, baseCommit: 'base-sha' };

	it('stores only the explicit PR document identity', function () {
		assert.strictEqual(getViewedLinesKey(uri, params), 'viewedLines:["host","/workspace/repo/src/example.ts","origin",1,"head-sha","src/example.ts",false,null]');
	});

	it('isolates authorities, roots, remotes, pull requests, revisions, files, and diff sides', function () {
		const keys = [
			getViewedLinesKey(uri, params),
			getViewedLinesKey({ ...uri, authority: 'other-host' }, params),
			getViewedLinesKey({ ...uri, path: '/workspace/other-repo/src/example.ts' }, params),
			getViewedLinesKey(uri, { ...params, remoteName: 'upstream' }),
			getViewedLinesKey(uri, { ...params, prNumber: 2 }),
			getViewedLinesKey(uri, { ...params, headCommit: 'new-head' }),
			getViewedLinesKey(uri, { ...params, fileName: 'src/other.ts' }),
			getViewedLinesKey(uri, { ...params, isBase: true }),
		];

		assert.strictEqual(new Set(keys).size, keys.length);
	});

	it('isolates base revisions without discarding unchanged head-side progress', function () {
		assert.notStrictEqual(getViewedLinesKey(uri, { ...params, isBase: true }), getViewedLinesKey(uri, { ...params, isBase: true, baseCommit: 'new-base' }));
		assert.strictEqual(getViewedLinesKey(uri, params), getViewedLinesKey(uri, { ...params, baseCommit: 'new-base' }));
	});

	it('keeps field boundaries unambiguous when values contain separators', function () {
		assert.notStrictEqual(getViewedLinesKey({ authority: 'host:path', path: 'file' }, params), getViewedLinesKey({ authority: 'host', path: 'path:file' }, params));
		assert.notStrictEqual(getViewedLinesKey(uri, { ...params, headCommit: 'head:file', fileName: 'name.ts' }), getViewedLinesKey(uri, { ...params, headCommit: 'head', fileName: 'file:name.ts' }));
		assert.notStrictEqual(getViewedLinesKey(uri, { ...params, fileName: 'a","b.ts' }), getViewedLinesKey(uri, { ...params, fileName: 'a,b.ts' }));
	});
});
