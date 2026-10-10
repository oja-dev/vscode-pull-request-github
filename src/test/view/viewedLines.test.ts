/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitChangeType } from '../../common/file';
import { LineRange } from '../../common/viewedLines';
import { PRUriParams, Schemes } from '../../common/uri';
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

	function assertMarker(color: string): void {
		const createDecoration = vscode.window.createTextEditorDecorationType as SinonStub;
		const options = createDecoration.lastCall.args[0] as vscode.DecorationRenderOptions;
		assert.strictEqual(options.backgroundColor, undefined);
		assert.strictEqual(options.border, undefined);
		assert.strictEqual(options.borderColor, undefined);
		assert.strictEqual(options.borderWidth, undefined);
		assert.strictEqual(options.color, undefined);
		assert.strictEqual(options.opacity, undefined);
		assert.ok(options.gutterIconPath instanceof vscode.Uri);
		const uri = options.gutterIconPath.toString(true);
		const separator = uri.indexOf(',');
		const mediaType = uri.substring(0, separator);
		assert.match(mediaType, /^data:image\/svg\+xml(?:;[^,]*)?$/);
		const payload = uri.substring(separator + 1);
		const svg = mediaType.includes(';base64') ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
		assert.match(svg, /<svg\b[^>]*\bxmlns="http:\/\/www.w3.org\/2000\/svg"/);
		// A color on an empty SVG does not paint a marker.
		assert.match(svg, /<(?:path|rect|line|polyline|polygon|circle|ellipse)\b/);
		assert.match(svg, new RegExp(`\\bfill=["']${color}["']`, 'i'));
		assert.doesNotMatch(svg, /<script\b|\bon\w+\s*=/i);
		assert.doesNotMatch(svg, /(?:opacity|fill-opacity|stroke-opacity)="(?!1")[^"]*"/);
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

	it('uses an opaque gutter marker without changing text or background', function () {
		assertMarker('#8B5CF6');
	});

	it('falls back to the default marker for invalid runtime colors', function () {
		for (const color of [undefined, null, false, 123456, {}, [], ['#123456'], '', 'red', '#abc', '#12345g', '#12345678', ' #123456', '#123456\n', '#123456"/><script>alert(1)</script>']) {
			setMarkerColor(color);
			assertMarker('#8B5CF6');
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

		assertMarker('#a1B2c3');
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

	it('places one marker on every viewed line including the final document line', async function () {
		activeEditor = createEditor(prUri(), [new vscode.Selection(97, 0, 99, 1)]);
		visibleEditors = [activeEditor];

		await commands.executeCommand('pr.markSelectedLinesAsViewed');

		assert.deepStrictEqual(state.get(key), [[97, 99]]);
		assert.deepStrictEqual((activeEditor.setDecorations as SinonStub).lastCall.args, [decoration, [
			new vscode.Range(97, 0, 97, 0),
			new vscode.Range(98, 0, 98, 0),
			new vscode.Range(99, 0, 99, 0),
		]]);
	});

	it('clamps stored ranges to the document and skips ranges beyond its final line', async function () {
		assert.ok(activeEditor);
		await state.update(key, [[97, 102], [110, 112]]);

		visibleEditorsChanged.fire(visibleEditors);

		assertDecorations(activeEditor, [[97, 99]]);
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

	it('ignores mark and unmark commands when disabled and preserves stored lines', async function () {
		assert.ok(activeEditor);
		await state.update(key, [[1, 3]]);
		const update = sandbox.spy(state, 'update');
		setViewedLinesEnabled(false);

		activeEditor.selections = [new vscode.Selection(6, 0, 6, 0)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor.selections = [new vscode.Selection(1, 0, 4, 0)];
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');

		assert.strictEqual(update.called, false);
		assert.deepStrictEqual(state.get(key), [[1, 3]]);
		assertDecorations(activeEditor, []);
	});

	it('clears all visible decorations when disabled and restores them when enabled without reloading', async function () {
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

	it('restores persisted decorations when the controller is registered again', async function () {
		assert.ok(activeEditor);
		activeEditor.selections = [new vscode.Selection(1, 0, 3, 1)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		disposeController();
		activeEditor = createEditor();
		visibleEditors = [activeEditor];

		registerViewedLines(context);

		assert.deepStrictEqual(state.get(key), [[1, 3]]);
		assertDecorations(activeEditor, [[1, 3]]);
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
			prUri('head', false, 'base', { remoteName: '' }),
			prUri('head', false, 'base', { prNumber: 0 }),
			prUri('head', false, 'base', { prNumber: -1 }),
			prUri('head', false, 'base', { prNumber: 1.5 }),
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
		let releaseWrite!: () => void;
		const firstWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
		const save = state.update.bind(state);
		const update = sandbox.stub(state, 'update').callsFake(save);
		update.onFirstCall().callsFake(async (key, value) => {
			await firstWrite;
			await save(key, value);
		});

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
		let releaseWrite!: () => void;
		const firstWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
		const save = state.update.bind(state);
		const update = sandbox.stub(state, 'update').callsFake(save);
		update.onFirstCall().callsFake(async (key, value) => {
			await firstWrite;
			await save(key, value);
		});

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

	it('keeps viewed lines separate for each head commit, base commit, and diff side', async function () {
		assert.ok(activeEditor);
		const headEditor = activeEditor;
		headEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		const nextHeadEditor = createEditor(prUri('next-head'), [new vscode.Selection(4, 0, 4, 0)]);
		const baseEditor = createEditor(prUri('head', true), [new vscode.Selection(6, 0, 6, 0)]);
		const nextBaseEditor = createEditor(prUri('head', true, 'next-base'), [new vscode.Selection(8, 0, 8, 0)]);
		visibleEditors = [headEditor, nextHeadEditor, baseEditor, nextBaseEditor];
		activeEditor = nextHeadEditor;
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor = baseEditor;
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		activeEditor = nextBaseEditor;
		await commands.executeCommand('pr.markSelectedLinesAsViewed');

		assert.deepStrictEqual(state.get(key), [[1, 1]]);
		assertDecorations(headEditor, [[1, 1]]);
		assertDecorations(nextHeadEditor, [[4, 4]]);
		assertDecorations(baseEditor, [[6, 6]]);
		assertDecorations(nextBaseEditor, [[8, 8]]);
	});

	it('isolates repository and PR identities while restoring reordered queries with changed status', async function () {
		const uris = [
			prUri(),
			prUri().with({ authority: 'other-host' }),
			prUri().with({ path: '/other-root/src/main.ts' }),
			prUri('head', false, 'base', { remoteName: 'upstream' }),
			prUri('head', false, 'base', { prNumber: 2 }),
		];
		const editors = uris.map((uri, index) => createEditor(uri, [new vscode.Selection(index * 2 + 1, 0, index * 2 + 1, 0)]));
		visibleEditors = editors;
		for (const editor of editors) {
			activeEditor = editor;
			await commands.executeCommand('pr.markSelectedLinesAsViewed');
		}

		assert.deepStrictEqual(state.get(key), [[1, 1]]);
		assertDecorations(editors[0], [[1, 1]]);
		assertDecorations(editors[1], [[3, 3]]);
		assertDecorations(editors[2], [[5, 5]]);
		assertDecorations(editors[3], [[7, 7]]);
		assertDecorations(editors[4], [[9, 9]]);

		disposeController();
		const reopenedEditors = uris.map(uri => {
			const params = JSON.parse(uri.query) as PRUriParams;
			return createEditor(uri.with({
				query: JSON.stringify({
					status: GitChangeType.RENAME,
					previousFileName: 'src/previous.ts',
					prNumber: params.prNumber,
					remoteName: params.remoteName,
					isBase: params.isBase,
					fileName: params.fileName,
					baseCommit: 'updated-base',
					headCommit: params.headCommit,
				}),
			}));
		});
		visibleEditors = reopenedEditors;
		registerViewedLines(context);

		assertDecorations(reopenedEditors[0], [[1, 1]]);
		assertDecorations(reopenedEditors[1], [[3, 3]]);
		assertDecorations(reopenedEditors[2], [[5, 5]]);
		assertDecorations(reopenedEditors[3], [[7, 7]]);
		assertDecorations(reopenedEditors[4], [[9, 9]]);

		activeEditor = reopenedEditors[0];
		activeEditor.selections = [new vscode.Selection(1, 0, 1, 0)];
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');

		assert.strictEqual(state.get(key), undefined);
		assertDecorations(reopenedEditors[0], []);
		assertDecorations(reopenedEditors[1], [[3, 3]]);
		assertDecorations(reopenedEditors[2], [[5, 5]]);
		assertDecorations(reopenedEditors[3], [[7, 7]]);
		assertDecorations(reopenedEditors[4], [[9, 9]]);
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

function prUri(headCommit = 'head', isBase = false, baseCommit = 'base', overrides: Partial<PRUriParams> = {}): vscode.Uri {
	return vscode.Uri.from({
		scheme: Schemes.Pr,
		path: '/src/main.ts',
		query: JSON.stringify({
			headCommit,
			baseCommit,
			fileName: 'src/main.ts',
			isBase,
			prNumber: 1,
			status: GitChangeType.MODIFY,
			remoteName: 'origin',
			...overrides,
		}),
	});
}
