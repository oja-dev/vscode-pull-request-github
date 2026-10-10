/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PR_SETTINGS_NAMESPACE, VIEWED_LINES_ENABLED } from '../common/settingKeys';
import { fromPRUri, Schemes } from '../common/uri';
import { getViewedLinesKey, LineRange, updateViewedLines } from '../common/viewedLines';

/** Local progress for immutable PR diff documents; never changes GitHub's file-viewed state. */
export function registerViewedLines(context: vscode.ExtensionContext): void {
	const decoration = vscode.window.createTextEditorDecorationType({
		borderColor: new vscode.ThemeColor('githubPullRequests.viewedLineBorder'),
		borderStyle: 'solid',
		borderWidth: '0 0 0 3px',
		isWholeLine: true
	});
	let pending: Promise<void> = Promise.resolve();

	function isEnabled(): boolean {
		return vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(VIEWED_LINES_ENABLED, false);
	}

	function keyFor(editor: vscode.TextEditor): string | undefined {
		if (!isEnabled() || editor.document.uri.scheme !== Schemes.Pr) {
			return;
		}
		const params = fromPRUri(editor.document.uri);
		if (params?.prIdentifier && params.headCommit) {
			return getViewedLinesKey(params.prIdentifier, params.headCommit, params.fileName, params.isBase, params.baseCommit);
		}
	}

	function refresh(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const key = keyFor(editor);
			const ranges = key ? context.workspaceState.get<LineRange[]>(key, []) : [];
			editor.setDecorations(decoration, ranges.map(([start, end]) => new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER)));
		}
	}

	function mark(viewed: boolean): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const key = editor && keyFor(editor);
		if (!editor || !key) {
			return Promise.resolve();
		}
		const selections: LineRange[] = editor.selections.map(selection => [
			selection.start.line,
			// A selection ending at column zero does not include the next line.
			selection.end.line - (!selection.isEmpty && selection.end.character === 0 ? 1 : 0)
		]);
		const update = pending.then(async () => {
			if (!isEnabled()) {
				return;
			}
			const ranges = updateViewedLines(context.workspaceState.get<LineRange[]>(key, []), selections, viewed);
			await context.workspaceState.update(key, ranges.length ? ranges : undefined);
			refresh();
		});
		// A failed write must not prevent subsequent commands from running.
		pending = update.catch(() => { });
		return update;
	}

	context.subscriptions.push(
		decoration,
		vscode.commands.registerCommand('pr.markSelectedLinesAsViewed', () => mark(true)),
		vscode.commands.registerCommand('pr.unmarkSelectedLinesAsViewed', () => mark(false)),
		vscode.window.onDidChangeVisibleTextEditors(refresh),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${VIEWED_LINES_ENABLED}`)) {
				refresh();
			}
		})
	);
	refresh();
}
