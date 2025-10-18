import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentChangeEvent,
    Position,
    SemanticTokensParams,
    SemanticTokensBuilder,

} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { TextDocumentSyncKind, InsertTextFormat, Hover } from "vscode-languageserver";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { URI } from 'vscode-uri';

// ------------------ connection & documents ------------------
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// ------------------ storage ------------------
// Per-file map: uri -> Map<objectName -> Set<attrs>>
const fileAttrMap: Map<string, Map<string, Set<string>>> = new Map();

// Global merged symbol table: objectName -> Set<attrs>
const globalSymbols: Map<string, Set<string>> = new Map();

// Map symbolName -> { uri, range }
const definitions: Map<string, { uri: string, range: { start: Position, end: Position } }> = new Map();

export function getDefinitions(): ReadonlySet<string> {
    return new Set(definitions.keys());
}

const typeComments: Map<string, string> = new Map();

// ------------------ helpers ------------------

// identifier regex: allow letters, digits, underscore, + and -
// allow dotted suffixes (e.g. HCONS.LIST)
const IDENT_PART = "[A-Za-z0-9_+\\-*]+";
const IDENT_DOTTED = `${IDENT_PART}(?:\\.${IDENT_PART})*`;
const TYPE_PART = "[A-Za-z0-9_+\\-*]+";    // for types, allow '*'
// TODO: this looks wrong, should be IDENT_PART
// Tokenizer will capture optional leading '#' for things like '#hook'
const TOKEN_RE = new RegExp(`#?${IDENT_DOTTED}|\\[|\\]|<|>|,|&`, "g");

const tokenTypes = ['type-tdl', 'variable-tdl', 'property-tdl'];

let workspaceFolders: { name: string; uri: string }[] | undefined;

// Extract base name: strip leading '#' if present, then take leftmost segment before '.'
function baseName(token: string): string {
    if (!token) return token;
    const t = token.startsWith("#") ? token.slice(1) : token;
    const parts = t.split(".");
    return parts[0];
}

function mergeFileMapsToGlobal() {
    globalSymbols.clear();
    for (const [, objMap] of fileAttrMap) {
        for (const [obj, attrs] of objMap) {
            if (!globalSymbols.has(obj)) globalSymbols.set(obj, new Set());
            const g = globalSymbols.get(obj)!;
            for (const a of attrs) g.add(a);
        }
    }
}

// Add attribute to file-local map (ensures we can remove/update when file changes)
// function addAttributeToFileMap(fileUri: string, objectName: string, attr: string) {
//     if (!fileAttrMap.has(fileUri)) fileAttrMap.set(fileUri, new Map());
//     const objMap = fileAttrMap.get(fileUri)!;
//     if (!objMap.has(objectName)) objMap.set(objectName, new Set());
//     objMap.get(objectName)!.add(attr);
// }

// Utility: parse a single file and return its object->attrs map
function parseFileToMap(text: string, fileUri?: string): Map<string, Set<string>> {
    const result: Map<string, Set<string>> = new Map();

    // helper to add into local map
    const localAdd = (objectName: string, attr: string) => {
        if (!result.has(objectName)) result.set(objectName, new Set());
        result.get(objectName)!.add(attr);
    };

    // 1) Dot notation anywhere: A.B or A.B.C -> add object=A, attr=leftmost of B (split on '.')
    const dotRegex = new RegExp(`(${IDENT_PART})\\.(${IDENT_DOTTED})`, "g");
    let m: RegExpExecArray | null;
    while ((m = dotRegex.exec(text))) {
        const obj = m[1];
        const attrToken = m[2];
        const attr = attrToken.split(".")[0];
        localAdd(obj, attr);
    }

    const lines = text.split('\n');
    // Strip comments after ';' but keep code before
    const filteredText = lines
        .map(line => line.split(';')[0])  // take everything before first ';'
        .join('\n');

    const tokens = filteredText.match(TOKEN_RE) || [];

    // 2) Bracketed forms: find tokens and scan top-level elements inside each bracket after an object
    // const tokens = text.match(TOKEN_RE) || [];
    for (let i = 0; i < tokens.length - 2; i++) {
        const object = tokens[i];
        if (!object) continue;
        // object followed by '[' => we are parsing A [ ... ]
        if (tokens[i + 1] === "[") {
            // scan the bracket content, tracking depth to handle nested brackets
            let depth = 1;
            let j = i + 2;
            let expectingNewElement = true;
            while (j < tokens.length && depth > 0) {
                const tk = tokens[j];

                if (tk === "[") {
                    depth++;
                    expectingNewElement = true;
                    j++;
                    continue;
                }
                if (tk === "]") {
                    depth--;
                    j++;
                    // when exiting top-level bracket we stop; elements after are outside
                    continue;
                }
                // commas separate top-level elements only when depth == 1
                if (tk === "," && depth === 1) {
                    expectingNewElement = true;
                    j++;
                    continue;
                }

                // when at depth==1 and expecting start of element, the token should be the attribute (possibly dotted)
                if (depth === 1 && expectingNewElement) {
                    // only treat tokens that look like identifiers (#hook or ident...)
                    if (/^#?.+/.test(tk) && tk !== "<" && tk !== ">" && tk !== ",") {
                        const base = baseName(tk); // strip '#' and take leftmost part before '.'
                        localAdd(object, base);
                        expectingNewElement = false;
                        // skip the rest of this element (we'll let the loop continue and commas/brackets manage control)
                        j++;
                        continue;
                    }
                }

                // otherwise move on
                j++;
            } // end while scanning bracketed block
        }
    }

    // ---------- 2) Collect definitions (type-name := ...) ----------
    if (fileUri) {
        const defRegex = new RegExp(`(${IDENT_PART})\\s*:=`, "g");
        let match;
        const docLines = text.split(/\r?\n/);
        while ((match = defRegex.exec(text)) !== null) {
            const name = match[1];
            const offset = match.index;
            // Convert offset to line/character
            let remaining = offset;
            let line = 0;
            while (line < docLines.length && remaining >= docLines[line].length + 1) {
                remaining -= (docLines[line].length + 1);
                line++;
            }
            const start = { line, character: remaining };
            const end = { line, character: remaining + name.length };
            definitions.set(name, { uri: fileUri, range: { start, end } });

            const afterDef = text.slice(defRegex.lastIndex);
            // Match """ ... """ (non-greedy)
            const commentMatch = /(?:[ \t]*)\r?\n\s*\"\"\"\s*([\s\S]*?)\s*\"\"\"[ \t\n]*(\[[^:;|]*\]|[A-Za-z0-9_+*\-]*)[ \t\n]*\./.exec(afterDef);
            if (commentMatch) {

                const startIndex = commentMatch.index;
                const textBefore = afterDef.slice(0, startIndex);

                const dotRegex = /\.[^A-Za-z0-9_+*\-]/;
                if (!dotRegex.test(textBefore)) {
                    // if not dot, then a true period
                    typeComments.set(name, commentMatch[1].trim());
                }

            }
        }
    }

    return result;
}

// Update global state for a single file URI + text
function updateFileUri(fileUri: string, text: string) {
    // const map = parseFileToMap(text);
    const map = parseFileToMap(text, fileUri); // pass fileUri
    fileAttrMap.set(fileUri, map);
    mergeFileMapsToGlobal();
}

// Remove file from map (when deleted)
function removeFileUri(fileUri: string) {
    fileAttrMap.delete(fileUri);
    mergeFileMapsToGlobal();
}

// Get attributes for completion (returns array)
function getAttributesForObject(objectName: string): string[] {
    return Array.from(globalSymbols.get(objectName) || []);
}

const workspaceTags: Set<string> = new Set();

// populate workspaceTags whenever documents open/change
function indexTagsFromDocument(doc: TextDocument) {
    const text = doc.getText();
    const matches = text.match(/#([A-Za-z0-9_+\-]+)/g) || [];
    for (const m of matches) {
        workspaceTags.add(m.slice(1)); // store without #
    }
}

function getPossibleTags(): string[] {
    return Array.from(workspaceTags);
}


// ------------------ workspace scanning ------------------
function scanFolderForTdlFiles(rootPath: string) {
    let fileUris: string[] = []
    if (!fs.existsSync(rootPath)) return;
    const entries = fs.readdirSync(rootPath);

    // connection.console.log("we are in scanning");

    for (const entry of entries) {
        const full = path.join(rootPath, entry);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            scanFolderForTdlFiles(full);
            // connection.console.log("we are in scanning folder repeating");
        } else if (entry.endsWith(".tdl")) {
            try {
                const txt = fs.readFileSync(full, "utf8");
                // convert file path to file URI-like string used by documents/LS
                const fileUri = pathToFileURI(full);
                // connection.console.log(`we are in scanning files: ${fileUri}`);
                fileUris.push(fileUri);          // save the URI
                const map = parseFileToMap(txt, fileUri);
                fileAttrMap.set(fileUri, map);

                // also index tags
                const doc = TextDocument.create(fileUri, "tdl", 1, txt);
                indexTagsFromDocument(doc);
            } catch (e) {
                connection.console.error(`Error reading ${full}: ${String(e)}`);
            }
        }
    }

}

// Convert a local path to a file URI (used to match document.uri)
function pathToFileURI(p: string): string {
    // ensure platform-correct absolute path to file:// URI
    const resolved = path.resolve(p);
    const uri = `file://${resolved.split(path.sep).join("/")}`;
    return uri;
}

// ------------------ LSP handlers ------------------
connection.onInitialize((params) => {
    connection.console.log("TDL server: initialize");

    // scan workspace folders (if any)
    const folders = params.workspaceFolders || [];

    workspaceFolders = params.workspaceFolders ?? undefined;
    for (const f of folders) {
        try {
            const folderPath = fileURLToPath(f.uri);
            scanFolderForTdlFiles(folderPath);
        } catch (e) {
            connection.console.error(`Could not scan folder ${f.uri}: ${String(e)}`);
        }
    }
    // build globalSymbols initially
    mergeFileMapsToGlobal();

    // Token modifiers (optional)
    const tokenModifiers: string[] = [];

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { resolveProvider: false, triggerCharacters: [".", "[", " ", "#"] },
            definitionProvider: true,
            hoverProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: tokenTypes,
                    tokenModifiers: tokenModifiers
                },
                full: true
            }
        }
    };
});

// Keep our file map updated when documents change/open
// documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
//     updateFileUri(change.document.uri, change.document.getText());
//     indexTagsFromDocument(change.document);
// });

documents.onDidClose(e => {
    // removeFileUri(e.document.uri);
});

// Watch file system changes (create/delete/modify)
connection.onDidChangeWatchedFiles((params) => {
    for (const c of params.changes) {
        const uri = c.uri;
        if (!uri.endsWith(".tdl")) continue;
        try {
            if (fs.existsSync(fileURLToPath(uri))) {
                const txt = fs.readFileSync(fileURLToPath(uri), "utf8");
                updateFileUri(uri, txt);
            } else {
                removeFileUri(uri);
            }
        } catch (e) {
            connection.console.error(`FS watch error for ${uri}: ${String(e)}`);
        }
    }
});

function escapeMarkdown(str: string): string {
    return str.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const wordRange = getWordRangeAtPosition(doc, params.position);
    if (!wordRange) return null;

    const word = doc.getText(wordRange);

    // Look up in typeComments
    if (typeComments.has(word)) {
        return {
            contents: {
                kind: "markdown",
                value: escapeMarkdown(typeComments.get(word)!)
            },
            range: wordRange
        } as Hover;
    }

    return null;
});

connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const wordRange = getWordRangeAtPosition(doc, params.position);
    if (!wordRange) return [];

    const word = doc.getText(wordRange);

    if (definitions.has(word)) {
        const def = definitions.get(word)!;

        // find workspace folder containing this file
        const defUri = URI.parse(def.uri);
        // const folder = workspaceFolders?.find(f => defUri.fsPath.startsWith(URI.parse(f.uri).fsPath));
        const folder = workspaceFolders?.find(f => {
            const folderFsPath = URI.parse(f.uri).fsPath;
            const rel = path.relative(folderFsPath, defUri.fsPath);
            return !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (!folder) return [];

        const folderPath = URI.parse(folder.uri).fsPath;
        const relPath = path.relative(folderPath, defUri.fsPath);
        const uri = URI.file(path.join(folderPath, relPath)).toString();

        connection.console.log(`trying url ${uri}`);
        return {
            uri,
            range: def.range
        };
    }
    return [];
});

connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { data: [] };

    const tokensBuilder = new SemanticTokensBuilder();
    const typeNames = getDefinitions();

    const lines = doc.getText().split(/\r?\n/);
    let insideTriple = false;

    let tripleBlockStart: number | null = null;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const trimmed = line.trimStart();
        if (trimmed.startsWith(";")) {
            continue;
        }

        // --- 1) Detect triple-quote ranges on this line ---
        const tripleMatches = [...line.matchAll(/\"\"\"/g)];

        let ranges: [number, number][] = []; // the range of comments

        for (const m of tripleMatches) {
            const idx = m.index!;
            if (!insideTriple) {
                // entering quoted segment
                ranges.push([idx, line.length - 1]);
                tripleBlockStart = 1; // temporary end
            } else {
                if (tripleBlockStart) {
                    // meet triple a second time
                    ranges[ranges.length - 1][1] = idx + 3;
                }
                else {
                    // first meet triple, comes from a previous line
                    ranges.push([0, idx + 3]);
                }
            }

            insideTriple = !insideTriple;
        }

        tripleBlockStart = null;

        if (ranges.length > 1) {
            connection.console.log(`inspecting ranges for ${lineNum}: ${ranges}`)
        }
        // --- 2) Scan for words ---
        const wordRegex = /([A-Za-z0-9_+*\-]+)/g;
        for (const match of line.matchAll(wordRegex)) {
            const word = match[0];
            const start = match.index!;
            const end = start + word.length;

            // (a) skip if inside triple-quote range
            if ((ranges.some(([s, e]) => start >= s && end <= e)) || (insideTriple && ranges.length === 0)) continue;

            // (b) skip if immediately preceded by '#' or ':' or '"'
            if (start > 0 && (line[start - 1] === "#" || line[start - 1] === ":" || line[start - 1] === "\"")) continue;

            // (c) skip if any ';' appears before the token in this line
            if (line.slice(0, start).includes(";")) continue;

            // --- 3) Finally, highlight if this is a type name ---
            if (typeNames.has(word)) {
                tokensBuilder.push(
                    lineNum,
                    start,
                    word.length,
                    tokenTypes.indexOf("type-tdl"),
                    0
                );
            }
        }
    }

    const built = tokensBuilder.build();
    for (let i = 0; i < built.data.length; i += 5) {
        const [lineDelta, charDelta, length, tokenType, tokenModifiers] = built.data.slice(i, i + 5);
        // console.log(`Token at index ${i / 5}: typeIndex=${tokenType} (${tokenTypes[tokenType]}), modifiers=${tokenModifiers}`);
    }
    return tokensBuilder.build();
});

// Helper: simple word under cursor (for onDefinition and onHover only). 
// Temporarily constraining the window to be at most 50 characters before and after.
// (so at most 50 characters long)
function getWordRangeAtPosition(doc: TextDocument, pos: Position) {

    const offset = doc.offsetAt(pos);

    const windowSize = 50;

    // Compute window boundaries
    const windowStart = Math.max(0, offset - windowSize);
    // const windowEnd = Math.min(text.length, offset + windowSize);

    const windowText = doc.getText({ start: doc.positionAt(windowStart), end: doc.positionAt(offset + windowSize) });

    const windowBefore = windowText.slice(0, Math.min(windowSize, offset));
    const windowAfter = windowText.slice(Math.min(windowSize, offset), 2 * windowSize);

    // Match letters, digits, underscore, +, -, or dots
    let start = windowBefore.search(/([A-Za-z0-9_+*\-]+)$/);
    const endMatch = /([A-Za-z0-9_+*\-]+)/.exec(windowAfter);
    if (start > 0 && windowBefore[start - 1] === "#") {
        start = -1;
    }
    if (start === -1 || !endMatch) return null;
    // const startOffset = offset - RegExp.$1.length;
    const startOffset = windowStart + start;
    const endOffset = offset + endMatch[0].length;

    const a = {
        start: doc.positionAt(startOffset),
        end: doc.positionAt(endOffset)
    };

    return {
        start: doc.positionAt(startOffset),
        end: doc.positionAt(endOffset)
    };
}

// LSP save event
connection.onDidSaveTextDocument((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return;

    updateFileUri(params.textDocument.uri, doc.getText());
    indexTagsFromDocument(doc);
});

// Completion handler
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const orig_offset = doc.offsetAt(params.position);

    const window = 7500;

    const startPos = doc.positionAt(Math.max(0, orig_offset - window));
    const endPos = doc.positionAt(orig_offset);
    const textBefore = doc.getText({ start: startPos, end: endPos });

    const structuralChars = /[:\]\<\>\&]/; // update instantly only when these chars are typed

    if (structuralChars.test(doc.getText()[orig_offset])) {
        updateFileUri(params.textDocument.uri, doc.getText());
        indexTagsFromDocument(doc);
    }

    const lines = textBefore.split('\n');
    // Strip comments after ';' but keep code before
    const filteredText = lines
        .map(line => line.split(';')[0])  // take everything before first ';'
        .join('\n');

    const tokens = filteredText.match(TOKEN_RE) || [];

    // track top-level bracket depth and lastObject
    let depth = 0;
    let lastObjectStack: (string | null)[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        if (tk === "[") {
            depth++;
            // Object before this bracket owns everything inside it
            lastObjectStack.push(tokens[i - 1] || null);
        } else if (tk === "]") {
            depth--;
            lastObjectStack.pop();
        }
    }

    const lastObject = lastObjectStack.length > 0 ? lastObjectStack[lastObjectStack.length - 1] : null;

    // Case 0: Tags after '#'
    const tagMatch = /#([A-Za-z0-9_+\-]*)$/.exec(textBefore);
    if (tagMatch) {
        const prefix = tagMatch[1] || "";
        const allTags = getPossibleTags();
        const filtered = allTags.filter(t => t.startsWith(prefix));
        const items: CompletionItem[] = filtered.map((tag, index) => ({
            label: "#" + tag,
            kind: CompletionItemKind.Variable,
            sortText: index.toString().padStart(4, "0"),
        }));
        connection.console.log(`${items}`);
        return items;
    }

    // Case 1: A.<cursor>
    const dotMatch = new RegExp(`(${IDENT_PART})\\.$`).exec(textBefore);
    if (dotMatch) {
        const objectName = dotMatch[1];
        return makeCompletionItems(getAttributesForObject(objectName), false);
    }

    const dotAttrMatch = new RegExp(`(${IDENT_PART})\\.(${IDENT_PART})$`).exec(textBefore);
    if (dotAttrMatch) {
        const objectName = dotAttrMatch[1];
        const prefix = dotAttrMatch[2]; // the thing typed after the dot
        const attrs = getAttributesForObject(objectName);
        const filtered = attrs.filter(a => a.startsWith(prefix));
        return makeCompletionItems(filtered, false);
    }


    // Case 2: A [ <cursor> or A & a [ <cursor>
    const bracketMatch = new RegExp(`(${IDENT_PART})(?:\\s+${TYPE_PART}\\s*&)?\\s*\\[\\s*$`).exec(textBefore);;
    if (bracketMatch) {
        const objectName = bracketMatch[1];
        return makeCompletionItems(getAttributesForObject(objectName), true);
    }

    // // Case 2b: A [ w<cursor>
    // const bracketPrefixMatch = new RegExp(
    //     `(${ IDENT_PART })(?: \\s + ${ TYPE_PART }\\s *&) ?\\s *\\[\\s * (${ IDENT_PART }) $`
    // ).exec(textBefore);

    // if (bracketPrefixMatch) {
    //     const objectName = bracketPrefixMatch[1];
    //     const attrPrefix = bracketPrefixMatch[2];
    //     const attrs = getAttributesForObject(objectName).filter(a => a.startsWith(attrPrefix));
    //     return makeCompletionItems(attrs, true);
    // }

    // Case 3: Top-level comma after nested brackets

    const prefixMatch2 = new RegExp(`(${IDENT_PART})$`).exec(textBefore);
    const typedPrefix = prefixMatch2 ? prefixMatch2[1] : "";

    // create a tokens copy and, if there's a typed prefix, append it as a synthetic final token
    let tokensScan = tokens.slice();
    if (typedPrefix && tokensScan.length && tokensScan[tokensScan.length - 1] === typedPrefix) {
        tokensScan = tokensScan.slice(0, -1); // drop the trailing unfinished identifier
    }

    // Scan backwards to see if last comma is at top-level (depth=1)
    let commaDepth = 0;
    for (let i = tokensScan.length - 1; i >= 0; i--) {
        const tk = tokensScan[i];
        if (tk === "]") commaDepth++;
        else if (tk === "[") {
            if (commaDepth === 0) { break; } // A [ B b_val, C ]
            commaDepth--;
        }
        else if (tk === "," && commaDepth === 0 && lastObject) {
            // Suggest top-level object attributes
            const prependSpace = /\s*$/.test(textBefore[textBefore.length - 1]) ? false : true;
            let completions: CompletionItem[] = [];
            completions.push({
                label: '⏎',                    // visual indicator
                kind: CompletionItemKind.Snippet,
                insertText: '\n$0',            // snippet with cursor
                insertTextFormat: InsertTextFormat.Snippet,
                sortText: '0000'
            });
            return completions.concat(makeCompletionItems(getAttributesForObject(lastObject), prependSpace));
        }
        else if (!(/\s/.test(tk))) { break; }
    }

    const cursorOffset = doc.offsetAt(params.position);
    const windowStart = Math.max(0, cursorOffset - 50);  // scan at most 200 chars backwards
    const lineText = doc.getText({ start: doc.positionAt(windowStart), end: params.position });

    const prefixMatch = /[A-Za-z0-9_+\-*]*$/.exec(lineText);
    const prefix = prefixMatch ? prefixMatch[0] : '';

    if (prefix.length > 0) {
        const matches: string[] = [];
        for (const sym of globalSymbols.keys()) {
            if (sym.startsWith(prefix)) matches.push(sym);
        }
        return makeCompletionItems(matches, false);
    };

    return [];

    function makeCompletionItems(attrs: string[], prependSpace: boolean): CompletionItem[] {
        const sorted = attrs.slice().sort((a, b) => {
            const aUpper = /^[A-Z0-9_+\-]+$/.test(a);
            const bUpper = /^[A-Z0-9_+\-]+$/.test(b);
            if (aUpper && !bUpper) return -1;
            if (!aUpper && bUpper) return 1;
            return a.localeCompare(b);
        });

        const toprependSpace = prependSpace && (textBefore.endsWith("[") ? true : false);
        return sorted.map((attr, index) => ({
            label: attr,
            kind: CompletionItemKind.Field,
            sortText: (index + 1).toString().padStart(4, "0"),
            insertText: toprependSpace ? " " + attr : attr
        }));
    }
});

documents.listen(connection);
connection.listen();
