// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
// export function activate(context: vscode.ExtensionContext) {

// 	// Use the console to output diagnostic information (console.log) and errors (console.error)
// 	// This line of code will only be executed once when your extension is activated
// 	console.log('Congratulations, your extension "tdl-support" is now active!');

// 	// The command has been defined in the package.json file
// 	// Now provide the implementation of the command with registerCommand
// 	// The commandId parameter must match the command field in package.json
// 	const disposable = vscode.commands.registerCommand('tdl-support.hellovscode', () => {
// 		// The code you place here will be executed every time your command is executed
// 		// Display a message box to the user
// 		vscode.window.showInformationMessage('GREAT Hello VSCode from tdl-support!');
// 	});

// 	context.subscriptions.push(disposable);
// }

export function activate(context: vscode.ExtensionContext) {
	// Existing command registration
	// console.log('Congratulations, your extension "tdl-support" is now active!');
	const disposable = vscode.commands.registerCommand('tdl-support.hellovscode', () => {
		vscode.window.showInformationMessage('GREAT Hello VSCode from tdl-support!');
	});
	context.subscriptions.push(disposable);

	// settings

	vscode.workspace.getConfiguration('editor', { languageId: 'tdl' }).update(
		'formatOnType', true, vscode.ConfigurationTarget.Workspace
	);
	vscode.workspace.getConfiguration('editor', { languageId: 'tdl' }).update(
		'autoIndent', 'none', vscode.ConfigurationTarget.Workspace
	);
	vscode.workspace.getConfiguration('editor', { languageId: 'tdl' }).update(
		'semanticHighlighting.enabled', true, vscode.ConfigurationTarget.Workspace
	);

	// ------------------ Language Server Setup ------------------

	// Path to compiled server.js
	const serverModule = context.asAbsolutePath(
		path.join('out', 'server.js')
	);

	// Server options
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] }
		}
	};

	// Client options
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'tdl' }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.tdl')
		}
	};

	// Create & start the client
	client = new LanguageClient(
		'tdlLanguageServer',
		'TDL Language Server',
		serverOptions,
		clientOptions
	);

	context.subscriptions.push(client.start());

	// console.log('Registering TDL on-type formatter');
	context.subscriptions.push(
		vscode.languages.registerOnTypeFormattingEditProvider(
			{ language: 'tdl', scheme: 'file' },
			new TdlOnTypeFormatter(),
			'\n'  // only trigger when Enter is pressed
		));

}

// This method is called when your extension is deactivated
// export function deactivate() { }
export function deactivate(): Thenable<void> | undefined {
	return undefined;
}

class TdlOnTypeFormatter implements vscode.OnTypeFormattingEditProvider {
	provideOnTypeFormattingEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		ch: string,
		// options: vscode.FormattingOptions,
		// token: vscode.CancellationToken
	): vscode.TextEdit[] {
		const edits: vscode.TextEdit[] = [];

		// Only work for newline
		if (ch !== '\n') return edits;

		const line = document.lineAt(position.line);

		// old approach
		// const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		// Count unclosed brackets to determine indentation level
		// const depth = this.computeBracketDepth(textBeforeCursor);

		// NOTE: we currently let the active curser decide where to indent, but this may not be the best approach
		let pos = position;
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			// const active = editor.selection.active;
			// if (active.isBefore(pos)) {
			pos = editor.selection.active; // adjust to the actual cursor
			// }
		}
		const newIndent = ' '.repeat(this.computeIndentForLine(document, pos));

		// Replace existing whitespace at the start of the line
		const currentIndentMatch = line.text.match(/^(\s*)/);
		const currentIndent = currentIndentMatch ? currentIndentMatch[1] : '';
		if (currentIndent !== newIndent) {
			edits.push(vscode.TextEdit.replace(
				new vscode.Range(line.range.start, line.range.start.translate(0, currentIndent.length)),
				newIndent
			));
		}

		return edits;
	}

	private computeIndentForLine(document: vscode.TextDocument, position: vscode.Position): number {

		// Step 1: Get full text up to this line
		const textUpToLine = document.getText(
			new vscode.Range(new vscode.Position(0, 0), position)
		);

		// Step 2: Backtrace to find the outermost unmatched '[' before this line
		let depth = 0;
		let outerBracketOffset = -1;
		for (let i = textUpToLine.length - 1; i >= 0; i--) {
			const ch = textUpToLine[i];
			if (ch === ']') depth++;
			else if (ch === '[') {
				if (depth === 0) {
					outerBracketOffset = i;
					break;
				} else {
					depth--;
				}
			}
		}
		// console.log('offset:', outerBracketOffset);
		if (outerBracketOffset === -1) return 0; // no enclosing bracket, indent = 0

		// Step 3: Find first non-whitespace character after that bracket
		let i = outerBracketOffset + 1;
		const textLength = document.getText().length;
		while (i < textLength) {
			const ch = document.getText().charAt(i);
			if (ch !== ' ' && ch !== '\t' && ch !== '\n') break;
			i++;
		}
		// console.log('new i:', i);
		// Step 4: Map that offset back to line and column
		const pos = document.positionAt(i);
		// console.log('pos: ', pos);
		if (pos.line === position.line) return pos.character; // indent within the same line
		else {
			// Non-whitespace is on a previous line; use its column
			return pos.character;
		}
	}
}
