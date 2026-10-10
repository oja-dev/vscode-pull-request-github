/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitChangeType } from '../../common/file';
import { LineRange } from '../../common/viewedLines';
import { toPRUri } from '../../common/uri';
import type { PullRequestModel } from '../../github/pullRequestModel';
import { registerViewedLines } from '../../view/viewedLines';
import { InMemoryMemento } from '../mocks/inMemoryMemento';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';

describe('Viewed line commands', function () {
	let sandbox: SinonSandbox;
	let commands: MockCommandRegistry;
	let context: vscode.ExtensionContext;
	let state: InMemoryMemento;
	let activeEditor: vscode.TextEditor | undefined;
	let visibleEditors: vscode.TextEditor[];
	let visibleEditorsChanged: vscode.EventEmitter<readonly vscode.TextEditor[]>;
	let configurationChanged: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;
	let viewedLinesEnabled: boolean | undefined;
	let markerColor: unknown;
	let decoration: vscode.TextEditorDecorationType;
	const key = 'viewedLines:["","/src/main.ts","origin",1,"head","src/main.ts",false,null]';

	function createEditor(uri = prUri(), selections = [new vscode.Selection(0, 0, 0, 0)], lineCount = 100): vscode.TextEditor {
		return {
			document: { uri, lineCount },
			selections,
			setDecorations: sandbox.stub(),
		} as unknown as vscode.TextEditor;
	}

	function assertDecorations(editor: vscode.TextEditor, ranges: LineRange[]): void {
		const setDecorations = editor.setDecorations as SinonStub;
		assert.deepStrictEqual(setDecorations.lastCall.args, [
			decoration,
			ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, offset) => new vscode.Range(start + offset, 0, start + offset, 0))),
		]);
	}

	async function assertMarker(color: string): Promise<void> {
		const options = (vscode.window.createTextEditorDecorationType as SinonStub).lastCall.args[0] as vscode.DecorationRenderOptions;
		assert.strictEqual(options.backgroundColor, undefined);
		assert.strictEqual(options.border, undefined);
		assert.strictEqual(options.borderColor, undefined);
		assert.strictEqual(options.borderWidth, undefined);
		assert.strictEqual(options.color, undefined);
		assert.strictEqual(options.opacity, undefined);
		assert.ok(options.gutterIconPath instanceof vscode.Uri);
		assert.strictEqual(options.gutterIconPath.scheme, 'data');
		const response = await fetch(options.gutterIconPath.toString(true));
		assert.match(response.headers.get('content-type') ?? '', /^image\/svg\+xml/);
		const svg = await response.text();
		assert.match(svg, /<svg\b[^>]*xmlns=["']http:\/\/www.w3.org\/2000\/svg["']/);
		assert.match(svg, /<(?:path|rect|line|polyline|polygon|circle|ellipse)\b/);
		assert.match(svg, new RegExp(`\\bfill=["']${color}["']`, 'i'));
		assert.doesNotMatch(svg, /<script\b|\bon\w+\s*=/i);
	}

	function setMarkerColor(color: unknown): void {
		markerColor = color;
		configurationChanged.fire({
			affectsConfiguration: section => section === 'githubPullRequests.viewedLines.markerColor',
		});
	}

	function setViewedLinesEnabled(enabled: boolean | undefined): void {
		viewedLinesEnabled = enabled;
		configurationChanged.fire({
			affectsConfiguration: section => section === 'githubPullRequests.viewedLines.enabled',
		});
	}

	function disposeController(): void {
		context.subscriptions.forEach(disposable => disposable.dispose());
		context.subscriptions.length = 0;
	}

	function delayFirstWrite(): { update: SinonStub; releaseWrite: () => void } {
		let releaseWrite!: () => void;
		const firstWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
		const save = state.update.bind(state);
		const update = sandbox.stub(state, 'update').callsFake(save);
		update.onFirstCall().callsFake(async (key, value) => {
			await firstWrite;
			await save(key, value);
		});
		return { update, releaseWrite };
	}

	beforeEach(function () {
		sandbox = createSandbox();
		commands = new MockCommandRegistry(sandbox);
		state = new InMemoryMemento();
		context = { workspaceState: state, subscriptions: [] } as unknown as vscode.ExtensionContext;
		sandbox.stub(vscode.window, 'createTextEditorDecorationType').callsFake(() => {
			decoration = { key: 'viewed-lines', dispose: sandbox.stub() } as vscode.TextEditorDecorationType;
			return decoration;
		});
		activeEditor = createEditor();
		visibleEditors = [activeEditor];
		sandbox.stub(vscode.window, 'activeTextEditor').get(() => activeEditor);
		sandbox.stub(vscode.window, 'visibleTextEditors').get(() => visibleEditors);
		visibleEditorsChanged = new vscode.EventEmitter<readonly vscode.TextEditor[]>();
		sandbox.stub(vscode.window, 'onDidChangeVisibleTextEditors').callsFake(visibleEditorsChanged.event);
		viewedLinesEnabled = true;
		markerColor = undefined;
		const getSetting = sandbox.stub().callsFake((section: string, defaultValue?: unknown) => {
			if (section === 'viewedLines.enabled') {
				return viewedLinesEnabled ?? defaultValue;
			}
			if (section === 'viewedLines.markerColor') {
				return markerColor === undefined ? defaultValue : markerColor;
			}
			return defaultValue;
		});
		sandbox.stub(vscode.workspace, 'getConfiguration').withArgs('githubPullRequests').returns({
			get: getSetting,
		} as unknown as vscode.WorkspaceConfiguration);
		configurationChanged = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
		sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(configurationChanged.event);
		registerViewedLines(context);
	});

	afterEach(function () {
		disposeController();
		visibleEditorsChanged.dispose();
		configurationChanged.dispose();
		sandbox.restore();
	});

	it('uses the default color for unset and invalid settings', async function () {
		await assertMarker('#8B5CF6');
		for (const color of [null, false, 123456, {}, [], ['#123456'], '', 'red', '#abc', '#12345g', '#12345678', ' #123456', '#123456\n', '#123456"/><script>alert(1)</script>']) {
			setMarkerColor(color);
			await assertMarker('#8B5CF6');
		}
	});

	it('applies a mixed-case custom color and refreshes all visible editors', async function () {
		assert.ok(activeEditor);
		activeEditor.selections = [new vscode.Selection(1, 0, 3, 1)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		const secondEditor = createEditor();
		const otherHeadEditor = createEditor(prUri('other-head'));
		visibleEditors = [activeEditor, secondEditor, otherHeadEditor];
		const previousDecoration = decoration;
		const update = sandbox.spy(state, 'update');

		setMarkerColor('#a1B2c3');

		await assertMarker('#a1B2c3');
		assert.notStrictEqual(decoration, previousDecoration);
		assert.strictEqual((previousDecoration.dispose as SinonStub).callCount, 1);
		assert.strictEqual((decoration.dispose as SinonStub).callCount, 0);
		assertDecorations(activeEditor, [[1, 3]]);
		assertDecorations(secondEditor, [[1, 3]]);
		assertDecorations(otherHeadEditor, []);
		assert.strictEqual(update.called, false);
		assert.deepStrictEqual(state.get(key), [[1, 3]]);
	});

	it('disposes the current marker after repeated color changes and stops listening', function () {
		const firstDecoration = decoration;
		setMarkerColor('#123456');
		const secondDecoration = decoration;
		setMarkerColor('#ABCDEF');
		const finalDecoration = decoration;
		const createDecoration = vscode.window.createTextEditorDecorationType as SinonStub;
		const previousCallCount = createDecoration.callCount;

		disposeController();
		setMarkerColor('#654321');

		assert.strictEqual((firstDecoration.dispose as SinonStub).callCount, 1);
		assert.strictEqual((secondDecoration.dispose as SinonStub).callCount, 1);
		assert.strictEqual((finalDecoration.dispose as SinonStub).callCount, 1);
		assert.strictEqual(createDecoration.callCount, previousCallCount);
	});

	it('marks the final line and clips restored ranges without rewriting saved progress', async function () {
		activeEditor = createEditor(prUri(), [new vscode.Selection(97, 0, 99, 1)]);
		visibleEditors = [activeEditor];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		assert.deepStrictEqual(state.get(key), [[97, 99]]);
		const expected = [new vscode.Range(97, 0, 97, 0), new vscode.Range(98, 0, 98, 0), new vscode.Range(99, 0, 99, 0)];
		assert.deepStrictEqual((activeEditor.setDecorations as SinonStub).lastCall.args, [decoration, expected]);

		await state.update(key, [[97, 102], [110, 112]]);
		visibleEditorsChanged.fire(visibleEditors);
		assert.deepStrictEqual((activeEditor.setDecorations as SinonStub).lastCall.args, [decoration, expected]);
		assert.deepStrictEqual(state.get(key), [[97, 102], [110, 112]]);
	});

	it('defaults to disabled when the setting is undefined', async function () {
		assert.ok(activeEditor);
		await state.update(key, [[1, 3]]);
		disposeController();
		viewedLinesEnabled = undefined;
		const update = sandbox.spy(state, 'update');

		registerViewedLines(context);
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');

		assert.strictEqual(update.called, false);
		assert.deepStrictEqual(state.get(key), [[1, 3]]);
		assertDecorations(activeEditor, []);
	});

	it('disables commands and markers without losing progress, then restores all visible editors', async function () {
		assert.ok(activeEditor);
		activeEditor.selections = [new vscode.Selection(1, 0, 3, 1)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		const secondEditor = createEditor();
		const otherHeadEditor = createEditor(prUri('other-head'));
		visibleEditors = [activeEditor, secondEditor, otherHeadEditor];
		visibleEditorsChanged.fire(visibleEditors);
		assertDecorations(activeEditor, [[1, 3]]);
		assertDecorations(secondEditor, [[1, 3]]);
		const update = sandbox.spy(state, 'update');

		setViewedLinesEnabled(false);

		visibleEditors.forEach(editor => assertDecorations(editor, []));
		activeEditor.selections = [new vscode.Selection(6, 0, 6, 0)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor.selections = [new vscode.Selection(1, 0, 4, 0)];
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		assert.deepStrictEqual(state.get(key), [[1, 3]]);

		setViewedLinesEnabled(true);

		assertDecorations(activeEditor, [[1, 3]]);
		assertDecorations(secondEditor, [[1, 3]]);
		assertDecorations(otherHeadEditor, []);
		assert.strictEqual(update.called, false);
	});

	it('marks reversed selections excluding a column-zero end, and unmarks selected lines', async function () {
		assert.ok(activeEditor);
		activeEditor.selections = [new vscode.Selection(4, 0, 1, 3)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		assert.deepStrictEqual(state.get(key), [[1, 3]]);
		assertDecorations(activeEditor, [[1, 3]]);

		activeEditor.selections = [new vscode.Selection(2, 0, 3, 0)];
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		assert.deepStrictEqual(state.get(key), [[1, 1], [3, 3]]);
		assertDecorations(activeEditor, [[1, 1], [3, 3]]);

		activeEditor.selections = [new vscode.Selection(1, 0, 4, 0)];
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		assert.strictEqual(state.get(key), undefined);
		assertDecorations(activeEditor, []);
	});

	it('marks cursor lines and all selections, including an end with a nonzero column', async function () {
		assert.ok(activeEditor);
		activeEditor.selections = [
			new vscode.Selection(2, 0, 2, 0),
			new vscode.Selection(5, 0, 7, 1),
			new vscode.Selection(9, 4, 9, 4),
		];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');

		assert.deepStrictEqual(state.get(key), [[2, 2], [5, 7], [9, 9]]);
		assertDecorations(activeEditor, [[2, 2], [5, 7], [9, 9]]);
	});

	it('refreshes decorations for every newly visible editor and clears unsupported editors', async function () {
		assert.ok(activeEditor);
		activeEditor.selections = [new vscode.Selection(3, 0, 3, 0)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		const reopenedEditor = createEditor();
		const otherHeadEditor = createEditor(prUri('other-head'));
		const fileEditor = createEditor(vscode.Uri.file('/src/main.ts'));
		visibleEditors = [reopenedEditor, otherHeadEditor, fileEditor];

		visibleEditorsChanged.fire(visibleEditors);

		assertDecorations(reopenedEditor, [[3, 3]]);
		assertDecorations(otherHeadEditor, []);
		assertDecorations(fileEditor, []);
	});

	it('ignores commands without an editor or a supported PR identity', async function () {
		const update = sandbox.spy(state, 'update');
		const unsupportedUris = [
			vscode.Uri.file('/src/main.ts'),
			prUri().with({ query: '' }),
			prUri().with({ query: '{invalid' }),
			prUri().with({ query: JSON.stringify({ headCommit: 'head', fileName: 'src/main.ts', isBase: false }) }),
			prUri(''),
			prUri('head', ''),
			prUri('head', 'origin', 0),
			prUri('head', 'origin', -1),
			prUri('head', 'origin', 1.5),
		];
		for (const uri of unsupportedUris) {
			activeEditor = createEditor(uri);
			await commands.executeCommand('pr.markSelectedLinesAsViewed');
			await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		}
		activeEditor = undefined;
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');

		assert.strictEqual(update.called, false);
	});

	it('serializes rapid writes and captures each command selection before waiting', async function () {
		assert.ok(activeEditor);
		const { update, releaseWrite } = delayFirstWrite();

		activeEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		const first = commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor.selections = [new vscode.Selection(3, 0, 3, 0)];
		const second = commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		const third = commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		await Promise.resolve();
		assert.strictEqual(update.callCount, 1);

		releaseWrite();
		await Promise.all([first, second, third]);

		assert.strictEqual(update.callCount, 3);
		assert.deepStrictEqual(state.get(key), [[3, 3]]);
		assertDecorations(activeEditor, [[3, 3]]);
	});

	it('skips queued mark and unmark writes if the setting is disabled while waiting', async function () {
		assert.ok(activeEditor);
		const { update, releaseWrite } = delayFirstWrite();

		activeEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		const first = commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor.selections = [new vscode.Selection(3, 0, 3, 0)];
		const second = commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		const third = commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		await Promise.resolve();
		assert.strictEqual(update.callCount, 1);

		setViewedLinesEnabled(false);
		releaseWrite();
		await Promise.all([first, second, third]);

		assert.strictEqual(update.callCount, 1);
		assert.deepStrictEqual(state.get(key), [[1, 1]]);
		assertDecorations(activeEditor, []);

		setViewedLinesEnabled(true);

		assertDecorations(activeEditor, [[1, 1]]);
	});

	it('round-trips producer-created PR URIs across controller re-registration and metadata changes', async function () {
		assert.ok(activeEditor);
		const uri = activeEditor.document.uri;
		activeEditor.selections = [new vscode.Selection(1, 0, 3, 1)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		const otherUri = prUri('head', 'origin', 2);
		activeEditor = createEditor(otherUri, [new vscode.Selection(7, 0, 7, 0)]);
		visibleEditors = [activeEditor];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		disposeController();

		const params = { ...JSON.parse(uri.query), status: GitChangeType.RENAME, previousFileName: 'old.ts', baseCommit: 'updated-base' };
		const reordered = Object.fromEntries(Object.entries(params).reverse());
		activeEditor = createEditor(uri.with({ query: JSON.stringify(reordered) }), [new vscode.Selection(1, 0, 4, 0)]);
		const otherEditor = createEditor(otherUri);
		visibleEditors = [activeEditor, otherEditor];
		registerViewedLines(context);
		assert.deepStrictEqual(state.get(key), [[1, 3]]);
		assertDecorations(activeEditor, [[1, 3]]);
		assertDecorations(otherEditor, [[7, 7]]);

		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');
		assert.strictEqual(state.get(key), undefined);
		assertDecorations(activeEditor, []);
		assertDecorations(otherEditor, [[7, 7]]);
	});

	it('continues processing commands after a rejected persistence write', async function () {
		assert.ok(activeEditor);
		const failure = new Error('Storage unavailable');
		const save = state.update.bind(state);
		sandbox.stub(state, 'update').callsFake(save).onFirstCall().rejects(failure);
		activeEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		await assert.rejects(commands.executeCommand('pr.markSelectedLinesAsViewed'), candidate => candidate === failure);

		activeEditor.selections = [new vscode.Selection(3, 0, 3, 0)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');

		assert.deepStrictEqual(state.get(key), [[3, 3]]);
		assertDecorations(activeEditor, [[3, 3]]);
	});
});

function prUri(headCommit = 'head', remoteName = 'origin', prNumber = 1): vscode.Uri {
	const pullRequest = { number: prNumber, githubRepository: { remote: { remoteName } } } as PullRequestModel;
	return toPRUri(vscode.Uri.file('/src/main.ts'), pullRequest, 'base', headCommit, 'src/main.ts', false, GitChangeType.MODIFY);
}
