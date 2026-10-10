/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import { PR_SETTINGS_NAMESPACE, VIEWED_LINES_ENABLED, VIEWED_LINES_MARKER_COLOR } from '../common/settingKeys';
import { fromPRUri, Schemes } from '../common/uri';
import { getViewedLinesKey, LineRange, updateViewedLines } from '../common/viewedLines';

/** Local progress for immutable PR diff documents; never changes GitHub's file-viewed state. */
export function registerViewedLines(context: vscode.ExtensionContext): void {
	let decoration = createDecoration();

	function createDecoration(): vscode.TextEditorDecorationType {
		const configuredColor = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(VIEWED_LINES_MARKER_COLOR, '#8B5CF6');
		const color = typeof configuredColor === 'string' && configuredColor.length === 7 && /^#[0-9a-f]{6}$/i.test(configuredColor)
			? configuredColor : '#8B5CF6';
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="16"><rect width="3" height="16" fill="${color}"/></svg>`;
		return vscode.window.createTextEditorDecorationType({
			gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`),
			gutterIconSize: 'contain'
		});
	}

	let pending: Promise<void> = Promise.resolve();

	function isEnabled(): boolean {
		return vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(VIEWED_LINES_ENABLED, false);
	}

	function keyFor(editor: vscode.TextEditor): string | undefined {
		if (!isEnabled() || editor.document.uri.scheme !== Schemes.Pr) {
			return;
		}
		const params = fromPRUri(editor.document.uri);
		if (params?.remoteName && params.headCommit && Number.isInteger(params.prNumber) && params.prNumber > 0) {
			return getViewedLinesKey(editor.document.uri, params);
		}
	}

	function refresh(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const key = keyFor(editor);
			const ranges = key ? context.workspaceState.get<LineRange[]>(key, []) : [];
			const lines: vscode.Range[] = [];
			for (const [start, end] of ranges) {
				for (let line = start; line <= Math.min(end, editor.document.lineCount - 1); line++) {
					lines.push(new vscode.Range(line, 0, line, 0));
				}
			}
			editor.setDecorations(decoration, lines);
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
		{ dispose: () => decoration.dispose() },
		vscode.commands.registerCommand('pr.markSelectedLinesAsViewed', () => mark(true)),
		vscode.commands.registerCommand('pr.unmarkSelectedLinesAsViewed', () => mark(false)),
		vscode.window.onDidChangeVisibleTextEditors(refresh),
		vscode.workspace.onDidChangeConfiguration(event => {
			const colorChanged = event.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${VIEWED_LINES_MARKER_COLOR}`);
			if (colorChanged) {
				decoration.dispose();
				decoration = createDecoration();
			}
			if (colorChanged || event.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${VIEWED_LINES_ENABLED}`)) {
				refresh();
			}
		})
	);
	refresh();
}
