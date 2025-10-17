# tdl-extension

This is an experimental VSCode extension of Type Definition Language (TDL) files used in [DELPH-IN](https://delph-in.github.io/docs/home/Home/) for computational linguistic processing with HPSG and MRS analysis. The syntax of TDL files can be viewed [here](https://delph-in.github.io/docs/tools/TdlRFC/). It is still under development -- usable, but expect a lot of bugs, and the speed is not satisfactory for large grammars such as [ERG](https://github.com/delph-in/erg) (mainly due to the large `lexicon.tdl`), but should be sufficient for grammars generated from the [Grammar Matrix](https://github.com/delph-in/matrix).

The extension currently supports:

- Syntactic Highlights: comments, strings, docstrings, brackets, definition operator (DEFOP, `:=`), multiple inheritance operator (AND, `&`), tag variables;
- Semantic Highlights of defined types (except for `*top*`);
- Go-to definitions with docstring display on hovering;
- Autocompletion of types and features based on attribute paths (buggy);
- Automatic indentation upon newline (buggy).
