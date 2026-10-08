/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { LineRange, getReviewedLinesKey, updateReviewedLines } from '../../common/reviewedLines';

describe('Reviewed line ranges', function () {
	it('marks the first line of an empty file review', function () {
		assert.deepStrictEqual(updateReviewedLines([], [[0, 0]], true), [[0, 0]]);
	});

	it('merges adjacent ranges on both sides', function () {
		assert.deepStrictEqual(updateReviewedLines([[2, 4], [7, 9]], [[5, 6]], true), [[2, 9]]);
	});

	it('merges overlapping and contained ranges without shrinking them', function () {
		assert.deepStrictEqual(updateReviewedLines([[2, 8]], [[6, 10], [3, 4], [2, 5]], true), [[2, 10]]);
	});

	it('sorts disjoint ranges and preserves unreviewed gaps', function () {
		assert.deepStrictEqual(updateReviewedLines([[10, 12]], [[20, 20], [0, 2], [5, 7]], true), [[0, 2], [5, 7], [10, 12], [20, 20]]);
	});

	it('merges a selection that bridges several existing ranges', function () {
		assert.deepStrictEqual(updateReviewedLines([[0, 2], [5, 7], [10, 12]], [[2, 10]], true), [[0, 12]]);
	});

	it('is idempotent when marking the same range repeatedly', function () {
		const marked = updateReviewedLines([[0, 2]], [[5, 7], [5, 7]], true);
		assert.deepStrictEqual(marked, [[0, 2], [5, 7]]);
		assert.deepStrictEqual(updateReviewedLines(marked, [[5, 7]], true), marked);
	});

	it('splits an existing range when its middle is unmarked', function () {
		assert.deepStrictEqual(updateReviewedLines([[0, 9]], [[3, 6]], false), [[0, 2], [7, 9]]);
	});

	it('splits a range around a single unmarked line', function () {
		assert.deepStrictEqual(updateReviewedLines([[0, 4]], [[2, 2]], false), [[0, 1], [3, 4]]);
	});

	it('trims the beginning of a reviewed range', function () {
		assert.deepStrictEqual(updateReviewedLines([[2, 9]], [[0, 4]], false), [[5, 9]]);
	});

	it('trims the end of a reviewed range', function () {
		assert.deepStrictEqual(updateReviewedLines([[2, 9]], [[7, 12]], false), [[2, 6]]);
	});

	it('removes a fully covered range, including a single line', function () {
		assert.deepStrictEqual(updateReviewedLines([[2, 9]], [[2, 9]], false), []);
		assert.deepStrictEqual(updateReviewedLines([[2, 9]], [[0, 12]], false), []);
		assert.deepStrictEqual(updateReviewedLines([[0, 0]], [[0, 0]], false), []);
	});

	it('removes a selection spanning multiple reviewed ranges', function () {
		assert.deepStrictEqual(updateReviewedLines([[0, 2], [5, 7], [10, 12]], [[1, 11]], false), [[0, 0], [12, 12]]);
	});

	it('leaves reviewed ranges unchanged when unmarked lines are absent', function () {
		assert.deepStrictEqual(updateReviewedLines([[2, 4], [8, 10]], [[0, 1], [5, 7], [11, 12]], false), [[2, 4], [8, 10]]);
		assert.deepStrictEqual(updateReviewedLines([], [[0, 10]], false), []);
	});

	it('applies multiple removals and tolerates repeated removals', function () {
		assert.deepStrictEqual(updateReviewedLines([[0, 10]], [[7, 8], [2, 3], [2, 3]], false), [[0, 1], [4, 6], [9, 10]]);
	});

	it('preserves ranges when there are no selections', function () {
		assert.deepStrictEqual(updateReviewedLines([[0, 2], [5, 7]], [], true), [[0, 2], [5, 7]]);
		assert.deepStrictEqual(updateReviewedLines([[0, 2], [5, 7]], [], false), [[0, 2], [5, 7]]);
	});

	for (const reviewed of [true, false]) {
		it(`does not mutate input arrays or tuples when ${reviewed ? 'marking' : 'unmarking'} lines`, function () {
			const current: LineRange[] = [[8, 10], [0, 5]];
			const selections: LineRange[] = [[4, 9], [2, 3]];
			current.forEach(range => Object.freeze(range));
			selections.forEach(range => Object.freeze(range));
			Object.freeze(current);
			Object.freeze(selections);

			const result = updateReviewedLines(current, selections, reviewed);

			assert.deepStrictEqual(current, [[8, 10], [0, 5]]);
			assert.deepStrictEqual(selections, [[4, 9], [2, 3]]);
			assert.notStrictEqual(result, current);
			assert.deepStrictEqual(result, reviewed ? [[0, 10]] : [[10, 10], [0, 1]]);
		});
	}
});

describe('Reviewed line storage keys', function () {
	const pr = 'https://github.com/owner/repository/pull/1';
	const head = 'head-sha';
	const file = 'src/example.ts';

	it('returns a stable key for the same review context', function () {
		assert.strictEqual(getReviewedLinesKey(pr, head, file, false), getReviewedLinesKey(pr, head, file, false));
	});

	it('isolates pull requests, revisions, files, and diff sides', function () {
		const keys = [
			getReviewedLinesKey(pr, head, file, false),
			getReviewedLinesKey('https://github.com/owner/repository/pull/2', head, file, false),
			getReviewedLinesKey('https://github.com/owner/another-repository/pull/1', head, file, false),
			getReviewedLinesKey(pr, 'new-head-sha', file, false),
			getReviewedLinesKey(pr, head, 'src/other.ts', false),
			getReviewedLinesKey(pr, head, file, true),
		];

		assert.strictEqual(new Set(keys).size, keys.length);
	});

	it('isolates base revisions without discarding unchanged head-side progress', function () {
		assert.notStrictEqual(getReviewedLinesKey(pr, head, file, true, 'base-1'), getReviewedLinesKey(pr, head, file, true, 'base-2'));
		assert.strictEqual(getReviewedLinesKey(pr, head, file, false, 'base-1'), getReviewedLinesKey(pr, head, file, false, 'base-2'));
	});

	it('keeps field boundaries unambiguous when identifiers contain separators', function () {
		assert.notStrictEqual(getReviewedLinesKey('owner:repo', 'head', 'file.ts', false), getReviewedLinesKey('owner', 'repo:head', 'file.ts', false));
		assert.notStrictEqual(getReviewedLinesKey('pr', 'head:file', 'name.ts', false), getReviewedLinesKey('pr', 'head', 'file:name.ts', false));
		assert.notStrictEqual(getReviewedLinesKey('pr', 'head', 'a","b.ts', false), getReviewedLinesKey('pr', 'head', 'a,b.ts', false));
	});
});
