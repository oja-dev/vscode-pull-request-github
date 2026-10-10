/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { LineRange, getViewedLinesKey } from '../../common/viewedLines';
import { Schemes } from '../../common/uri';
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
	let getSetting: SinonStub;
	let decoration: vscode.TextEditorDecorationType;
	const key = getViewedLinesKey('owner/repo#1', 'head', 'src/main.ts', false);

	function createEditor(uri = prUri(), selections = [new vscode.Selection(0, 0, 0, 0)]): vscode.TextEditor {
		return {
			document: { uri },
			selections,
			setDecorations: sandbox.stub(),
		} as unknown as vscode.TextEditor;
	}

	function assertDecorations(editor: vscode.TextEditor, ranges: LineRange[]): void {
		const setDecorations = editor.setDecorations as SinonStub;
		assert.deepStrictEqual(setDecorations.lastCall.args, [
			decoration,
			ranges.map(([start, end]) => new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER)),
		]);
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
		decoration = { key: 'viewed-lines', dispose: sandbox.stub() } as vscode.TextEditorDecorationType;
		sandbox.stub(vscode.window, 'createTextEditorDecorationType').returns(decoration);
		activeEditor = createEditor();
		visibleEditors = [activeEditor];
		sandbox.stub(vscode.window, 'activeTextEditor').get(() => activeEditor);
		sandbox.stub(vscode.window, 'visibleTextEditors').get(() => visibleEditors);
		visibleEditorsChanged = new vscode.EventEmitter<readonly vscode.TextEditor[]>();
		sandbox.stub(vscode.window, 'onDidChangeVisibleTextEditors').callsFake(visibleEditorsChanged.event);
		viewedLinesEnabled = true;
		getSetting = sandbox.stub().callsFake((_section: string, defaultValue?: unknown) => viewedLinesEnabled ?? defaultValue);
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

	it('marks whole lines with only a theme left border without changing text or background', function () {
		const createDecoration = vscode.window.createTextEditorDecorationType as SinonStub;
		assert.deepStrictEqual(createDecoration.firstCall.args, [{
			borderColor: new vscode.ThemeColor('githubPullRequests.viewedLineBorder'),
			borderStyle: 'solid',
			borderWidth: '0 0 0 3px',
			isWholeLine: true
		}]);
	});

	it('defaults to disabled when the setting is undefined', async function () {
		assert.ok(activeEditor);
		await state.update(key, [[1, 3]]);
		disposeController();
		viewedLinesEnabled = undefined;
		getSetting.resetHistory();
		const update = sandbox.spy(state, 'update');

		registerViewedLines(context);
		await commands.executeCommand('pr.markSelectedLinesAsViewed');
		await commands.executeCommand('pr.unmarkSelectedLinesAsViewed');

		assert.ok(getSetting.calledWithExactly('viewedLines.enabled', false));
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

	it('ignores unrelated configuration changes', function () {
		assert.ok(activeEditor);
		const setDecorations = activeEditor.setDecorations as SinonStub;
		setDecorations.resetHistory();
		getSetting.resetHistory();

		configurationChanged.fire({ affectsConfiguration: section => section === 'editor.fontSize' });

		assert.strictEqual(setDecorations.called, false);
		assert.strictEqual(getSetting.called, false);
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
		assert.deepStrictEqual(state.get(getViewedLinesKey('owner/repo#1', 'next-head', 'src/main.ts', false)), [[4, 4]]);
		assert.deepStrictEqual(state.get(getViewedLinesKey('owner/repo#1', 'head', 'src/main.ts', true, 'base')), [[6, 6]]);
		assert.deepStrictEqual(state.get(getViewedLinesKey('owner/repo#1', 'head', 'src/main.ts', true, 'next-base')), [[8, 8]]);
		assertDecorations(headEditor, [[1, 1]]);
		assertDecorations(nextHeadEditor, [[4, 4]]);
		assertDecorations(baseEditor, [[6, 6]]);
		assertDecorations(nextBaseEditor, [[8, 8]]);
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

function prUri(headCommit = 'head', isBase = false, baseCommit = 'base'): vscode.Uri {
	return vscode.Uri.from({
		scheme: Schemes.Pr,
		path: '/src/main.ts',
		query: JSON.stringify({
			prIdentifier: 'owner/repo#1',
			headCommit,
			baseCommit,
			fileName: 'src/main.ts',
			isBase,
			prNumber: 1,
		}),
	});
}
