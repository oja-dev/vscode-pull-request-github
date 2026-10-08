/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getReviewedLinesKey, LineRange, updateReviewedLines } from '../common/reviewedLines';
import { fromPRUri, Schemes } from '../common/uri';

/** Local progress for immutable PR diff documents; never changes GitHub's file-viewed state. */
export function registerReviewedLines(context: vscode.ExtensionContext): void {
	const decoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('githubPullRequests.reviewedLineBackground'),
		borderColor: new vscode.ThemeColor('githubPullRequests.reviewedLineBorder'),
		borderStyle: 'solid',
		borderWidth: '0 0 0 3px',
		isWholeLine: true
	});
	let pending: Promise<void> = Promise.resolve();

	function keyFor(editor: vscode.TextEditor): string | undefined {
		if (editor.document.uri.scheme !== Schemes.Pr) {
			return;
		}
		const params = fromPRUri(editor.document.uri);
		if (params?.prIdentifier && params.headCommit) {
			return getReviewedLinesKey(params.prIdentifier, params.headCommit, params.fileName, params.isBase, params.baseCommit);
		}
	}

	function refresh(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const key = keyFor(editor);
			const ranges = key ? context.workspaceState.get<LineRange[]>(key, []) : [];
			editor.setDecorations(decoration, ranges.map(([start, end]) => new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER)));
		}
	}

	function mark(reviewed: boolean): Promise<void> {
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
			const ranges = updateReviewedLines(context.workspaceState.get<LineRange[]>(key, []), selections, reviewed);
			await context.workspaceState.update(key, ranges.length ? ranges : undefined);
			refresh();
		});
		// A failed write must not prevent subsequent commands from running.
		pending = update.catch(() => { });
		return update;
	}

	context.subscriptions.push(
		decoration,
		vscode.commands.registerCommand('pr.markSelectedLinesReviewed', () => mark(true)),
		vscode.commands.registerCommand('pr.markSelectedLinesUnreviewed', () => mark(false)),
		vscode.window.onDidChangeVisibleTextEditors(refresh)
	);
	refresh();
}
